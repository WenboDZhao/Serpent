#!/usr/bin/env python3
"""Pixel-preserving Aseprite packaging and hash-fenced Serpent MCP maintenance (stdlib only)."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

HERE = Path(__file__).resolve().parent
CHUNK = 256 * 1024
OWNER = '.codex-animation-run'


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def digest(path):
    value = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(CHUNK), b''):
            value.update(chunk)
    return value.hexdigest()


def json_hash(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def write_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)


def generator_version(executable):
    scripts = hashlib.sha256()
    for name in ('assets.py', 'aseprite.lua'):
        scripts.update((HERE / name).read_bytes())
    version = subprocess.run([executable, '--version'], check=True, capture_output=True, text=True).stdout.strip()
    return f'aseprite-animation-assets/1:{scripts.hexdigest()[:16]}:{version}'


def aseprite(executable, mode, out, source=None, **params):
    command = [executable, '-b']
    if source:
        command.append(str(source))
    for name, value in dict(mode=mode, out=out, **params).items():
        command.extend(['--script-param', f'{name}={value}'])
    command.extend(['--script', str(HERE / 'aseprite.lua')])
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode or not Path(out).is_file():
        raise RuntimeError(f'Aseprite {mode} failed: {result.stderr.strip() or result.stdout.strip()}')


def integer(value, minimum=0):
    return isinstance(value, int) and not isinstance(value, bool) and value >= minimum


def validate_recipe(recipe):
    assert recipe.get('version') == 1, 'Unsupported recipe version'
    assert 1 <= len(recipe['actions']) <= 2, 'Choose one or two actions'
    assert 1 <= len(recipe['combinations']) <= 4, 'Choose one to four combinations'
    frame_count = 0
    for action in recipe['actions']:
        assert action['name'] and action['frames'], 'Action must be named and nonempty'
        assert len(action['frames']) == len(action['durationsMs']), 'Frame durations are required'
        assert all(integer(frame, 1) for frame in action['frames']), 'Frame indices are one-based'
        assert all(integer(duration, 10) and duration <= 60000 for duration in action['durationsMs']), 'Invalid duration'
        frame_count += len(action['frames'])
    for combination in recipe['combinations']:
        assert combination['name'], 'Combination must be named'
        if 'layers' in combination:
            assert all(parts and all(integer(part, 1) for part in parts) for parts in combination['layers']), 'Invalid layer path'
    crop = recipe['crop']
    assert all(integer(crop[key], 1 if key in ('width', 'height') else 0) for key in ('x', 'y', 'width', 'height')), 'Invalid crop'
    layout = recipe['layout']
    assert integer(layout['columns'], 1) and layout['columns'] <= 2, 'Invalid column count'
    assert integer(layout['scale'], 1) and layout['scale'] <= 16, 'Invalid pixel scale'
    assert integer(layout['padding']) and layout['padding'] <= 128, 'Invalid padding'
    recipe.setdefault('posterFrame', 0)
    assert integer(recipe['posterFrame']) and recipe['posterFrame'] < frame_count, 'Invalid poster frame'
    return recipe


def validate_manifest(manifest):
    name = manifest['name']
    assert Path(name).name == name and name.endswith('.aseprite'), 'Use an Aseprite basename'
    assert all(integer(manifest['canvas'][key], 1) for key in ('width', 'height')), 'Invalid canvas'
    assert manifest['layers'] and manifest['frames'], 'Layers and frames are required'
    originals = set()
    for frame in manifest['frames']:
        assert integer(frame['durationMs'], 1), 'Explicit source frame duration is required'
        used = set()
        for cel in frame['cels']:
            assert integer(cel['layer'], 1) and cel['layer'] <= len(manifest['layers']), 'Invalid layer index'
            assert cel['layer'] not in used, 'Only one cel per layer per frame'
            used.add(cel['layer'])
            filename = Path(cel['path'])
            assert filename.is_absolute() and filename.is_file() and not filename.is_symlink(), 'PNG must be an absolute regular file'
            assert filename.suffix.lower() == '.png', 'Conversion inputs must be PNG'
            originals.add(str(filename.resolve()))
    for action in manifest.get('actions', []):
        assert 1 <= action['from'] <= action['to'] <= len(manifest['frames']), 'Invalid action range'
    return originals


def new_run(parent=None):
    if parent:
        Path(parent).mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix='codex-animation-', dir=parent)).resolve()
    run = dict(version=1, runId=str(uuid.uuid4()), root=str(root), phase='created', originals={}, files=[])
    (root / OWNER).write_text(run['runId'], encoding='utf-8')
    save_run(run)
    return run


def save_run(run):
    root = Path(run['root'])
    run['files'] = sorted(str(file.relative_to(root)) for file in root.rglob('*') if file.is_file() and file.name != 'run.json.tmp')
    write_json(root / 'run.json', run)


def load_run(directory):
    root = Path(directory).absolute()
    assert not root.is_symlink() and root.resolve() == root, 'Run root must be canonical and not a symlink'
    run = read_json(root / 'run.json')
    assert run['version'] == 1 and run['root'] == str(root), 'Invalid run ownership'
    assert root.name.startswith('codex-animation-') and (root / OWNER).read_text() == run['runId'], 'Invalid run ownership marker'
    return run


def inspect_source(executable, source):
    with tempfile.TemporaryDirectory(prefix='codex-aseprite-inspect-') as directory:
        out = Path(directory) / 'inspection.json'
        aseprite(executable, 'inspect', out, source)
        return dict(read_json(out), sourceSha256=digest(source))


def render_run(run, executable):
    root = Path(run['root'])
    validate_recipe(read_json(root / 'recipe.json'))
    before = digest(root / run['sourceName'])
    aseprite(executable, 'render', root / 'preview.gif', root / run['sourceName'], recipe=root / 'recipe.json', record=root / 'render-record.json')
    assert digest(root / run['sourceName']) == before, 'Renderer changed the source'
    run.update(sourceSha256=before, previewSha256=digest(root / 'preview.gif'), generatorVersion=generator_version(executable), phase='prepared')
    save_run(run)


def prepare(args):
    recipe = validate_recipe(read_json(args.recipe))
    originals = {str(Path(args.source).resolve())} if args.source else validate_manifest(read_json(args.manifest))
    assert all(Path(file).is_file() and not Path(file).is_symlink() for file in originals), 'Originals must be regular files'
    run = new_run(args.work_parent)
    try:
        root = Path(run['root'])
        run['originals'] = {file: digest(file) for file in originals}
        write_json(root / 'recipe.json', recipe)
        if args.source:
            source = Path(args.source)
            assert source.suffix.lower() in ('.aseprite', '.ase'), 'Use an Aseprite source'
            run['sourceName'] = source.stem + '.aseprite'
            shutil.copyfile(source, root / run['sourceName'])
        else:
            manifest = read_json(args.manifest)
            run['sourceName'] = manifest['name']
            write_json(root / 'conversion.json', manifest)
            aseprite(args.aseprite, 'build', root / run['sourceName'], manifest=root / 'conversion.json')
        render_run(run, args.aseprite)
        assert all(digest(file) == sha for file, sha in run['originals'].items()), 'An original input changed during preparation'
        print(canonical(dict(run=run['root'], sourceSha256=run['sourceSha256'], previewSha256=run['previewSha256'], phase=run['phase'])))
    except BaseException as error:
        run.update(phase='prepare-failed', error=str(error)); save_run(run)
        print(f'Recovery directory: {run["root"]}', file=sys.stderr)
        raise


class Mcp:
    def __init__(self, url=None, token=None):
        self.url = url or os.environ.get('SERPENT_MCP_URL')
        self.token = token or os.environ.get('SERPENT_MCP_TOKEN')
        if not self.url or not self.token:
            raise RuntimeError('Set SERPENT_MCP_URL and SERPENT_MCP_TOKEN')
        self.session = None
        self.rpc('initialize', dict(protocolVersion='2025-03-26', capabilities={}, clientInfo=dict(name='aseprite-animation-assets', version='1')))
        self.rpc('notifications/initialized', notification=True)

    def rpc(self, method, params=None, notification=False):
        payload = dict(jsonrpc='2.0', method=method)
        if params is not None:
            payload['params'] = params
        if not notification:
            payload['id'] = str(uuid.uuid4())
        headers = {'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}
        if self.session:
            headers['Mcp-Session-Id'] = self.session
        request = urllib.request.Request(self.url, canonical(payload).encode(), headers)
        with urllib.request.urlopen(request, timeout=60) as response:
            self.session = response.headers.get('Mcp-Session-Id', self.session)
            text = response.read().decode()
        if notification or not text:
            return None
        if text.lstrip().startswith('{'):
            reply = json.loads(text)
        else:
            replies = [json.loads(line[5:].strip()) for line in text.splitlines() if line.startswith('data:')]
            reply = next(item for item in replies if item.get('id') == payload['id'])
        if 'error' in reply:
            raise RuntimeError('MCP JSON-RPC error: ' + str(reply['error'].get('message')))
        return reply['result']

    def call(self, name, library, **arguments):
        # Only transport failures are retried; requests are content-bound and use stable keys/offsets.
        for attempt in range(3):
            try:
                result = self.rpc('tools/call', dict(name=name, arguments=dict(libraryId=library, **arguments)))
                content = result.get('structuredContent')
                if content is None:
                    content = json.loads(next(item['text'] for item in result['content'] if item['type'] == 'text'))
                if not content.get('ok'):
                    raise RuntimeError(f'{content.get("code", "MCP_ERROR")}: {content.get("message", "Command failed")}')
                return content['result']
            except (urllib.error.URLError, TimeoutError):
                if attempt == 2:
                    raise
                time.sleep(0.2 * (attempt + 1))


def remote_hash(client, library, asset, kind, expected, destination=None):
    result_hash = hashlib.sha256()
    offset = 0
    stream = open(destination, 'wb') if destination else None
    try:
        while True:
            result = client.call('serpent_animation_read', library, assetId=asset, kind=kind, expectedSha256=expected, offsetBytes=offset, maxBytes=CHUNK)
            assert result['offsetBytes'] == offset and result['sha256'] == expected, 'Remote read fence failed'
            data = base64.b64decode(result['dataBase64'], validate=True)
            result_hash.update(data)
            if stream:
                stream.write(data)
            offset += len(data)
            if not result['truncated']:
                assert offset == result['byteSize'], 'Incomplete remote file'
                break
            assert data, 'Remote read made no progress'
    finally:
        if stream:
            stream.close()
    assert result_hash.hexdigest() == expected, 'Remote checksum mismatch'


def verify_remote(client, library, asset, expected_source=None, expected_preview=None, recipe=None, generator=None):
    info = client.call('serpent_animation_get', library, assetId=asset)
    assert info and not info['previewMissing'], 'Managed animation association or preview missing'
    generation = info['generation']
    assert info['sourceSha256'] == generation['sourceSha256'], 'Source changed after generation'
    if expected_source:
        assert info['sourceSha256'] == expected_source, 'Managed source differs from prepared source'
    if expected_preview:
        assert generation['previewSha256'] == expected_preview, 'Managed preview differs from prepared preview'
    if recipe:
        assert json_hash(info['recipe']) == json_hash(recipe) == generation['recipeSha256'], 'Recipe mismatch'
    if generator:
        assert generation['generatorVersion'] == generator, 'Generator record mismatch'
    remote_hash(client, library, asset, 'source', generation['sourceSha256'])
    remote_hash(client, library, asset, 'preview', generation['previewSha256'])
    return info


def cleanup(run):
    root = Path(run['root'])
    assert load_run(root)['runId'] == run['runId'], 'Run ownership changed'
    assert run['phase'] == 'verified', 'Cleanup requires a successful managed verification'
    # Preflight the whole tree before deleting anything. shutil.rmtree uses fd-based traversal on supported hosts.
    for member in [root, *root.rglob('*')]:
        assert not member.is_symlink() and member.resolve().is_relative_to(root), 'Cleanup refused a symlink or escaped path'
    assert not any(Path(file).is_relative_to(root) for file in run['originals']), 'An original is inside the run directory'
    try:
        shutil.rmtree(root)
    except BaseException as error:
        root.mkdir(parents=True, exist_ok=True)
        (root / OWNER).write_text(run['runId'], encoding='utf-8')
        run.update(phase='cleanup-failed', error=str(error)); save_run(run)
        raise


def finish(run, client, keep_work):
    root = Path(run['root'])
    recipe = read_json(root / 'recipe.json') if (root / 'recipe.json').exists() else run['receipt']['recipe']
    info = verify_remote(client, run['libraryId'], run['assetId'], run['sourceSha256'], run['previewSha256'], recipe, run['generatorVersion'])
    run.update(phase='verified', receipt=info); save_run(run)
    if not keep_work:
        cleanup(run)
        # No dependency on temporary files is allowed after cleanup.
        verify_remote(client, run['libraryId'], run['assetId'], run['sourceSha256'], run['previewSha256'], recipe, run['generatorVersion'])
    print(canonical(dict(assetId=run['assetId'], libraryId=run['libraryId'], status='completed', cleaned=not keep_work, previewSha256=info['generation']['previewSha256'])))


def import_run(args):
    run = load_run(args.run)
    assert not run.get('libraryId') or run['libraryId'] == args.library, 'Use resume for an existing target; do not switch libraries on retry'
    run['libraryId'] = args.library
    run['targetFolderId'] = args.target_folder
    run['mode'] = 'import'; save_run(run)
    resume_run(args, run)


def resume_run(args, run=None):
    run = run or load_run(args.run)
    client = Mcp()
    root = Path(run['root'])
    try:
        if run.get('receipt') and run.get('phase') == 'cleanup-failed':
            finish(run, client, args.keep_work)
            return
        assert digest(root / run['sourceName']) == run['sourceSha256'], 'Local source changed'
        assert digest(root / 'preview.gif') == run['previewSha256'], 'Local preview changed'
        recipe = validate_recipe(read_json(root / 'recipe.json'))
        if run['mode'] == 'import':
            arguments = dict(sourcePath=str(root / run['sourceName']), previewPath=str(root / 'preview.gif'),
                             sourceSha256=run['sourceSha256'], previewSha256=run['previewSha256'], recipe=recipe,
                             generatorVersion=run['generatorVersion'], idempotencyKey=run['runId'] + ':import')
            if run.get('targetFolderId'):
                arguments['targetFolderId'] = run['targetFolderId']
            info = client.call('serpent_animation_import', run['libraryId'], **arguments)
            run.update(assetId=info['assetId'], phase='imported'); save_run(run)
        else:
            current = client.call('serpent_animation_get', run['libraryId'], assetId=run['assetId'])
            record = current['generation'] if current else {}
            if (current and not current['previewMissing'] and current['sourceSha256'] == run['sourceSha256']
                    and record.get('sourceSha256') == run['sourceSha256']
                    and record.get('sourceRevisionId') == run['sourceRevisionId']
                    and record['previewSha256'] == run['previewSha256'] and record['recipeSha256'] == json_hash(recipe)
                    and record['generatorVersion'] == run['generatorVersion']):
                if run.get('stagingId'):
                    client.call('serpent_animation_preview_cancel', run['libraryId'], assetId=run['assetId'], stagingId=run['stagingId'])
                finish(run, client, args.keep_work)
                return
            run.setdefault('stagingId', str(uuid.uuid4())); save_run(run)
            offset = 0
            with open(root / 'preview.gif', 'rb') as stream:
                while True:
                    data = stream.read(CHUNK)
                    if not data:
                        break
                    client.call('serpent_animation_preview_stage', run['libraryId'], assetId=run['assetId'], stagingId=run['stagingId'],
                                expectedRevisionId=run['sourceRevisionId'], expectedSourceSha256=run['sourceSha256'], offsetBytes=offset,
                                dataBase64=base64.b64encode(data).decode(), complete=offset + len(data) == (root / 'preview.gif').stat().st_size)
                    offset += len(data)
            run['phase'] = 'staged'; save_run(run)
            client.call('serpent_animation_preview_publish', run['libraryId'], assetId=run['assetId'], stagingId=run['stagingId'], recipe=recipe,
                        generatorVersion=run['generatorVersion'], previewSha256=run['previewSha256'], idempotencyKey=run['runId'] + ':publish')
            run['phase'] = 'published'; save_run(run)
        finish(run, client, args.keep_work)
    except BaseException as error:
        if root.exists():
            if isinstance(error, KeyboardInterrupt) and run.get('stagingId'):
                try:
                    client.call('serpent_animation_preview_cancel', run['libraryId'], assetId=run['assetId'], stagingId=run['stagingId'])
                    run.pop('stagingId', None)
                except Exception:
                    pass
            run.update(phase='failed' if run.get('phase') != 'cleanup-failed' else run['phase'], error=str(error)); save_run(run)
        print(f'Incomplete; recovery directory: {root}', file=sys.stderr)
        raise


def update(args):
    client = Mcp()
    info = client.call('serpent_animation_get', args.library, assetId=args.asset)
    assert info, 'Asset has no animation association'
    recipe = validate_recipe(read_json(args.recipe) if args.recipe else info['recipe'])
    version = generator_version(args.aseprite)
    generation = info['generation']
    if (not info['previewMissing'] and info['sourceSha256'] == generation['sourceSha256']
            and json_hash(recipe) == generation['recipeSha256'] and version == generation['generatorVersion']):
        print(canonical(dict(assetId=args.asset, status='skipped', reason='unchanged')))
        return
    run = new_run(args.work_parent)
    root = Path(run['root'])
    try:
        run.update(mode='update', libraryId=args.library, assetId=args.asset, sourceName='source.aseprite',
                   sourceRevisionId=info['currentRevisionId'], sourceSha256=info['sourceSha256'])
        write_json(root / 'recipe.json', recipe)
        remote_hash(client, args.library, args.asset, 'source', info['sourceSha256'], root / run['sourceName'])
        render_run(run, args.aseprite)
        resume_run(args, run)
    except BaseException:
        if root.exists():
            save_run(run)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ('inspect', 'prepare', 'update', 'resume'):
        command = sub.add_parser(name)
        command.add_argument('--aseprite', default=os.environ.get('ASEPRITE_BIN', 'aseprite'))
        if name == 'inspect':
            command.add_argument('--source', required=True)
        elif name == 'prepare':
            group = command.add_mutually_exclusive_group(required=True)
            group.add_argument('--source'); group.add_argument('--manifest')
            command.add_argument('--recipe', required=True)
            command.add_argument('--work-parent')
        elif name == 'update':
            command.add_argument('--library', required=True); command.add_argument('--asset', required=True)
            command.add_argument('--recipe'); command.add_argument('--work-parent'); command.add_argument('--keep-work', action='store_true')
        else:
            command.add_argument('--run', required=True); command.add_argument('--keep-work', action='store_true')
    command = sub.add_parser('import')
    command.add_argument('--run', required=True); command.add_argument('--library', required=True)
    command.add_argument('--target-folder'); command.add_argument('--keep-work', action='store_true')
    args = parser.parse_args()
    if args.command == 'inspect':
        print(json.dumps(inspect_source(args.aseprite, args.source), ensure_ascii=False, indent=2))
    elif args.command == 'prepare':
        prepare(args)
    elif args.command == 'import':
        import_run(args)
    elif args.command == 'update':
        update(args)
    else:
        resume_run(args)


if __name__ == '__main__':
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        print(f'{type(error).__name__}: {error}', file=sys.stderr)
        sys.exit(1)
