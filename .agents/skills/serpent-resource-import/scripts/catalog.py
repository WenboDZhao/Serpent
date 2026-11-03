#!/usr/bin/env python3
"""图像/Shader 盘点、排重候选、计划检查与本地检查点；不执行 MCP 写操作。"""

import argparse
import collections
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import unicodedata
import warnings


IMAGE_EXTENSIONS = set('''
.png .jpg .jpeg .jfif .gif .webp .avif .svg .bmp .ico .tif .tiff .psd .exr .tga
.raw .dng .cr2 .cr3 .nef .arw .raf .orf .rw2 .ase .aseprite .ai .eps .ora .kra
.xcf .clip .procreate
'''.split())
SHADER_EXTENSIONS = set('''
.shader .shadergraph .shadersubgraph .gdshader .gdshaderinc .glsl .vert .frag
.geom .tesc .tese .comp .compute .hlsl .hlsli .cg .cginc .wgsl .fx .fxh .usf .ush .metal
'''.split())
AUXILIARY_EXTENSIONS = set('''
.json .meta .atlas .plist .xml .yaml .yml .yy .yyp .csv .txt .md .markdown
'''.split())
EXCLUDED_EXTENSIONS = set('''
.fbx .obj .blend .gltf .glb .stl .mtl .spine .skel .scml .scmls
.wav .mp3 .ogg .oga .m4a .aac .flac .opus .mp4 .mov .avi .wmv .webm .mkv .m4v .flv
.ttf .otf .woff .woff2 .ttc .pdf .doc .docx .xls .xlsx .ppt .pptx
.unity .prefab .unitypackage .asset .mat .material .anim .controller .overridecontroller
.tscn .tres .res .scn .godot .import .ctex .stex .cs .gd .gdextension .csproj .sln
.dll .exe .pdb .py .js .ts .lua .sh .bat .ps1 .ini .cfg .conf .log
'''.split())
ARCHIVE_EXTENSIONS = {'.zip', '.7z', '.rar', '.tar', '.gz', '.bz2', '.xz'}
PIXEL_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.jfif', '.gif', '.webp', '.bmp', '.tif', '.tiff'}
REQUIRED_ROLES = {'image', 'shader', 'archive', 'pending', 'error'}
STATUSES = ('prepared', 'submitted', 'imported', 'verified', 'failed', 'cancelled', 'cleanup-failed', 'cleaned')


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def value_hash(value):
    return hashlib.sha256(canonical(value).encode('utf-8')).hexdigest()


def no_symlinks(path):
    path = Path(os.path.abspath(Path(path).expanduser()))
    if any(part.is_symlink() for part in (path, *path.parents)):
        raise ValueError(f'不接受符号链接路径：{path}')
    return path


def output_path(path, roots):
    path = no_symlinks(path)
    resolved = path.resolve()
    if any(resolved == root or root in resolved.parents for root in roots):
        raise ValueError('记录输出不能位于原始目录内')
    return path


def stat_identity(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def file_hash(path):
    path = no_symlinks(path)
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode):
        raise ValueError(f'不是普通文件：{path}')
    digest = hashlib.sha256()
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(descriptor, 'rb') as stream:
        if stat_identity(os.fstat(stream.fileno())) != stat_identity(before):
            raise ValueError(f'读取前文件变化：{path}')
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    if stat_identity(path.lstat()) != stat_identity(before):
        raise ValueError(f'读取期间文件变化：{path}')
    return digest.hexdigest()


def classify(relative):
    path = PurePosixPath(relative)
    parts = {part.casefold() for part in path.parts}
    name = path.name.casefold()
    suffix = path.suffix.lower()
    if name.startswith('._') or name == '.ds_store' or '__macosx' in parts:
        return 'excluded', 'macOS 附属文件'
    if parts & {'.godot', '.git', 'node_modules'}:
        return 'excluded', '已识别的生成缓存或工具内部文件'
    if suffix in SHADER_EXTENSIONS:
        return 'shader', 'Shader 例外；检查语言、目标引擎和依赖'
    if suffix in IMAGE_EXTENSIONS:
        return 'image', '图像或可编辑图像源；需查看内容并分组'
    if suffix in AUXILIARY_EXTENSIONS or name.startswith(('license', 'licence', 'readme', 'read_me', 'credits')):
        return 'auxiliary', '仅按需读取图像元数据或来源说明，不独立入库'
    if suffix in ARCHIVE_EXTENSIONS:
        return 'archive', '需先查看压缩包目录，压缩包不作为正式资产'
    if suffix in EXCLUDED_EXTENSIONS:
        return 'excluded', '非图像媒体、引擎工程/运行内容或普通脚本'
    return 'pending', '未知类型，需判断内容后记录去向'


def sniff(header):
    if header.startswith(b'\x89PNG\r\n\x1a\n'):
        return '.png'
    if header.startswith((b'GIF87a', b'GIF89a')):
        return '.gif'
    if header.startswith(b'\xff\xd8\xff'):
        return '.jpg'
    if header.startswith(b'8BPS'):
        return '.psd'
    if header[:4] == b'RIFF' and header[8:12] == b'WEBP':
        return '.webp'
    if len(header) >= 6 and header[4:6] == b'\xe0\xa5':
        return '.aseprite'
    return None


def pixel_info(path):
    from PIL import Image

    with warnings.catch_warnings():
        warnings.simplefilter('error', Image.DecompressionBombWarning)
        with Image.open(path) as image:
            result = {'width': image.width, 'height': image.height, 'frames': getattr(image, 'n_frames', 1)}
            if result['frames'] != 1 or image.mode not in {'1', 'L', 'LA', 'P', 'RGB', 'RGBA'}:
                result['pixelSkipped'] = '非单帧 8-bit raster'
                return result
            pixels = bytearray(image.convert('RGBA').tobytes())
            for offset in range(0, len(pixels), 4):
                if pixels[offset + 3] == 0:
                    pixels[offset:offset + 3] = b'\0\0\0'
            profile = image.info.get('icc_profile') or b''
            descriptor = {'algorithm': 'rgba8-canvas-v1', 'size': image.size, 'mode': image.mode,
                          'iccSha256': hashlib.sha256(profile).hexdigest(),
                          'gamma': image.info.get('gamma'), 'chromaticity': image.info.get('chromaticity')}
            digest = hashlib.sha256(canonical(descriptor).encode())
            digest.update(pixels)
            result['pixelSha256'] = digest.hexdigest()
            return result


def inspect_file(path, relative, hash_mode, pixels):
    record = {'recordType': 'file', 'path': relative}
    try:
        before = path.lstat()
        record.update(size=before.st_size, mtimeNs=before.st_mtime_ns, ctimeNs=before.st_ctime_ns)
        if not stat.S_ISREG(before.st_mode):
            record.update(role='pending', reason='符号链接或特殊文件，不跟随、不读取')
            return record
        role, reason = classify(relative)
        record.update(role=role, reason=reason)
        if role in {'image', 'pending'}:
            with path.open('rb') as stream:
                detected = sniff(stream.read(16))
            suffix = path.suffix.lower()
            expected = {'.jpeg': '.jpg', '.jfif': '.jpg', '.ase': '.aseprite'}.get(suffix, suffix)
            if detected and detected != expected:
                record.update(role='pending', reason='扩展名与图像文件头不一致，仅可在副本修复', detectedExtension=detected)
            elif expected in {'.png', '.gif', '.jpg', '.psd', '.aseprite', '.webp'} and detected is None:
                record.update(role='pending', reason='未识别到扩展名对应的图像文件头，需检查完整性')
        if hash_mode == 'all' or (hash_mode == 'candidates' and record['role'] in {'image', 'shader'}):
            record['sha256'] = file_hash(path)
        if pixels and record['role'] == 'image' and path.suffix.lower() in PIXEL_EXTENSIONS:
            try:
                record.update(pixel_info(path))
            except Exception as error:
                record['pixelError'] = str(error)
        if stat_identity(before) != stat_identity(path.lstat()):
            raise ValueError('扫描期间文件变化')
    except (OSError, ValueError) as error:
        record.pop('sha256', None)
        record.pop('pixelSha256', None)
        record.update(role='error', reason=str(error))
    return record


def walk_files(root):
    pending = [root]
    while pending:
        directory = pending.pop()
        try:
            with os.scandir(directory) as stream:
                entries = sorted(stream, key=lambda entry: entry.name)
        except OSError as error:
            yield {'recordType': 'file', 'path': directory.relative_to(root).as_posix(),
                   'role': 'error', 'reason': str(error)}
            continue
        for entry in entries:
            path = Path(entry.path)
            try:
                if entry.is_dir(follow_symlinks=False):
                    pending.append(path)
                else:
                    yield path
            except OSError as error:
                yield {'recordType': 'file', 'path': path.relative_to(root).as_posix(),
                       'role': 'error', 'reason': str(error)}


def scan(args):
    root = no_symlinks(args.source).resolve()
    if not root.is_dir():
        raise ValueError('源目录不存在')
    if args.pixels:
        try:
            from PIL import Image  # noqa: F401
        except ImportError as error:
            raise ValueError('--pixels 需要 Pillow；普通盘点不需要') from error
    out = output_path(args.out, [root])
    out.mkdir(parents=True, exist_ok=False)
    roles, extensions, groups = collections.Counter(), collections.Counter(), collections.Counter()
    total_bytes = pixel_errors = 0
    with (out / 'inventory.jsonl').open('x', encoding='utf-8') as stream:
        header = {'recordType': 'header', 'version': 1, 'sourceRoot': str(root), 'createdAt': now(),
                  'hashMode': args.hash, 'pixels': args.pixels}
        stream.write(canonical(header) + '\n')
        for item in walk_files(root):
            record = item if isinstance(item, dict) else inspect_file(item, item.relative_to(root).as_posix(), args.hash, args.pixels)
            stream.write(canonical(record) + '\n')
            roles[record['role']] += 1
            extensions[PurePosixPath(record['path']).suffix.lower() or '(noext)'] += 1
            groups[record['path'].split('/')[0]] += 1
            total_bytes += record.get('size', 0)
            pixel_errors += int('pixelError' in record)
        summary = {'complete': not roles['error'], 'files': sum(roles.values()), 'bytes': total_bytes,
                   'roles': dict(roles), 'extensions': dict(extensions), 'topLevel': dict(groups),
                   'pixelErrors': pixel_errors, 'finishedAt': now()}
        stream.write(canonical({'recordType': 'footer', **summary}) + '\n')
    (out / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return {'records': str(out), **summary}


def load_inventory(path):
    path = no_symlinks(path)
    header = footer = None
    records = {}
    with path.open(encoding='utf-8') as stream:
        for line in stream:
            record = json.loads(line)
            if record.get('recordType') == 'header':
                if header is not None or records:
                    raise ValueError('重复或顺序错误的 inventory header')
                header = record
            elif record.get('recordType') == 'footer':
                if footer is not None:
                    raise ValueError('重复 inventory footer')
                footer = record
            else:
                if header is None or footer is not None or record.get('recordType') != 'file':
                    raise ValueError('inventory 记录顺序/类型错误')
                if record['path'] in records:
                    raise ValueError('inventory 含重复路径')
                records[record['path']] = record
    if not header or header.get('version') != 1 or not footer or footer.get('files') != len(records):
        raise ValueError('inventory 未完整结束或版本不支持')
    return header, records, footer


def previous_records(path):
    path = no_symlinks(path)
    if path.suffix.lower() == '.jsonl':
        header, records, footer = load_inventory(path)
        if not footer['complete']:
            raise ValueError('旧 inventory 有读取错误，不能作为可靠排重依据')
        return header['sourceRoot'], records.values()
    data = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(data, dict) or not isinstance(data.get('files'), list):
        raise ValueError('旧清单需要 sourceRoot/files 或本脚本 JSONL 格式')
    return data['sourceRoot'], ({**record, 'path': record.get('relative', record.get('path'))} for record in data['files'])


def duplicates(args):
    header, records, footer = load_inventory(args.inventory)
    if not footer['complete']:
        raise ValueError('inventory 有读取错误，需先处理')
    groups = {'sha256': collections.defaultdict(list), 'pixelSha256': collections.defaultdict(list)}
    roots = [Path(header['sourceRoot']).resolve()]
    for record in records.values():
        if record['role'] not in {'image', 'shader'}:
            continue
        for field, index in groups.items():
            if record.get(field):
                index[record[field]].append({'scope': 'current', 'root': header['sourceRoot'], 'path': record['path']})
    for previous in args.previous:
        root, old = previous_records(previous)
        roots.append(Path(root).resolve())
        for record in old:
            if record.get('role') == 'error':
                continue
            for field, index in groups.items():
                if record.get(field) in index:
                    index[record[field]].append({'scope': 'previous', 'root': root, 'path': record['path']})
    out = output_path(args.out, roots)
    out.parent.mkdir(parents=True, exist_ok=True)
    counts = collections.Counter()
    with out.open('x', encoding='utf-8') as stream:
        for field, index in groups.items():
            for digest, members in sorted(index.items()):
                members = list({canonical(member): member for member in members}.values())
                if len(members) > 1:
                    stream.write(canonical({'kind': field, 'digest': digest, 'members': members, 'candidateOnly': True}) + '\n')
                    counts[field] += 1
    return {'out': str(out), 'groups': dict(counts), 'candidateOnly': True}


def relative_path(value):
    if not isinstance(value, str) or not value or '\\' in value or '\0' in value:
        return False
    path = PurePosixPath(value)
    return bool(path.parts) and not path.is_absolute() and path.as_posix() == value and all(part not in {'.', '..'} and ':' not in part for part in path.parts)


def filename(value):
    if not relative_path(value) or re.search(r'[<>:"/\\|?*\x00-\x1f]', value) or value != value.rstrip(' .'):
        return False
    return not re.fullmatch(r'CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]', value.split('.')[0], flags=re.I)


def safe_static_name(name):
    path = PurePosixPath(name)
    return f'{path.stem}_static{path.suffix}' if re.search(r'(?:\d+|\(\d+\))$', path.stem) else name


def plan_check(header, records, footer, plan, require_complete=False):
    errors, pending = [], []
    if plan.get('version') != 1 or plan.get('sourceRoot') != header['sourceRoot']:
        errors.append('计划版本或 sourceRoot 与 inventory 不符')
    if not footer.get('complete'):
        errors.append('扫描有读取错误，不能核验完成')
    assets, dispositions = plan.get('assets', []), plan.get('dispositions', [])
    if not isinstance(assets, list) or not isinstance(dispositions, list):
        return {'valid': False, 'errors': ['assets/dispositions 必须为数组']}
    keys, destinations, covered = set(), set(), set()
    for asset in assets:
        if not isinstance(asset, dict):
            errors.append('资产项必须为对象')
            continue
        key, kind = asset.get('key'), asset.get('kind')
        if not isinstance(key, str) or not key.strip() or key in keys:
            errors.append(f'空或重复 key：{key}')
        elif key:
            keys.add(key)
        if kind not in {'image', 'animation', 'shader'}:
            errors.append(f'{key}：kind 必须为 image/animation/shader')
        operation = asset.get('operation')
        if operation not in {'import', 'reuse', 'update'}:
            errors.append(f'{key}：缺少有效 operation')
        if operation in {'reuse', 'update'} and not asset.get('existingAssetId'):
            errors.append(f'{key}：复用/更新需要 existingAssetId')
        if not isinstance(asset.get('reason'), str) or not asset['reason'].strip():
            errors.append(f'{key}：缺少处理理由')
        name, folder = asset.get('name'), asset.get('folder')
        if not filename(name):
            errors.append(f'{key}：name 不是可移植文件名')
        elif kind == 'animation' and PurePosixPath(name).suffix.lower() not in {'.ase', '.aseprite'}:
            errors.append(f'{key}：动画正式源必须为 Aseprite')
        elif kind == 'shader' and PurePosixPath(name).suffix.lower() not in SHADER_EXTENSIONS:
            errors.append(f'{key}：Shader 必须保留 Shader 扩展名')
        elif kind == 'image' and PurePosixPath(name).suffix.lower() not in IMAGE_EXTENSIONS:
            errors.append(f'{key}：静态正式源必须为图像')
        elif kind == 'image' and name != safe_static_name(name):
            errors.append(f'{key}：静态名字可能被合并为序列图，建议 {safe_static_name(name)}')
        if not isinstance(folder, list) or not all(filename(part) for part in folder):
            errors.append(f'{key}：folder 必须为安全的目录名数组')
        elif filename(name):
            destination = unicodedata.normalize('NFC', '/'.join([*folder, name])).casefold()
            if destination in destinations:
                errors.append(f'{key}：目标目录内名字冲突')
            destinations.add(destination)
        tags = asset.get('tags')
        if not isinstance(tags, list) or not tags or not all(isinstance(tag, str) and tag.strip() for tag in tags):
            errors.append(f'{key}：缺少有效标签')
        else:
            if len(set(tags)) != len(tags):
                errors.append(f'{key}：标签重复')
            if not any(tag.startswith(('素材包/', '来源/')) for tag in tags):
                errors.append(f'{key}：需要来源标签，未知来源也应明确记录')
            if kind == 'shader':
                if 'Shader' not in tags or '图像' in tags or any(tag.startswith(('类型/', '人物/', '动物/', '植物/', '建筑/', '环境/', '地形/', 'UI/', '道具/', '特效/')) for tag in tags):
                    errors.append(f'{key}：Shader 使用 Shader 标识与自身细分标签，不使用图像内容标签')
            elif '图像' not in tags or not any(tag.startswith('类型/') for tag in tags):
                errors.append(f'{key}：图像需要图像标识与类型标签')
        sources, dependencies = asset.get('sources'), asset.get('dependencies', [])
        if not isinstance(sources, list) or not sources or not isinstance(dependencies, list):
            errors.append(f'{key}：sources 为非空数组，dependencies 为数组')
            continue
        for source in sources:
            record = records.get(source) if isinstance(source, str) else None
            expected = 'shader' if kind == 'shader' else 'image'
            if not relative_path(source) or not record or record['role'] != expected:
                errors.append(f'{key}：源不属于允许范围或未扫描：{source}')
            else:
                covered.add(source)
        for dependency in dependencies:
            record = records.get(dependency) if isinstance(dependency, str) else None
            if not relative_path(dependency) or not record or record['role'] not in {'auxiliary', 'image', 'shader'}:
                errors.append(f'{key}：辅助依赖不存在或范围不符：{dependency}')
    disposed = set()
    for item in dispositions:
        if not isinstance(item, dict):
            errors.append('disposition 必须为对象')
            continue
        path, action = item.get('path'), item.get('action')
        if not isinstance(path, str) or path not in records or path in disposed or path in covered:
            errors.append(f'去向路径不存在、重复或已作正式源：{path}')
            continue
        disposed.add(path)
        if action not in {'excluded', 'duplicate', 'pending'} or not isinstance(item.get('reason'), str) or not item['reason'].strip():
            errors.append(f'{path}：去向需要 action 和理由')
        if action == 'duplicate' and item.get('assetKey') not in keys and not item.get('existingAssetId'):
            errors.append(f'{path}：重复项需要有效 assetKey 或 existingAssetId')
        if action == 'pending':
            pending.append(path)
    accounted = covered | disposed
    missing = [path for path, record in records.items() if record['role'] in REQUIRED_ROLES and path not in accounted]
    if missing:
        errors.append(f'{len(missing)} 个候选/未知/压缩包缺少去向：{missing[:10]}')
    if require_complete and pending:
        errors.append(f'还有 {len(pending)} 个待处理项')
    return {'valid': not errors, 'assets': len(assets), 'pending': len(pending), 'uncovered': len(missing), 'errors': errors}


def load_plan(args):
    header, records, footer = load_inventory(args.inventory)
    plan = json.loads(no_symlinks(args.plan).read_text(encoding='utf-8'))
    if not isinstance(plan, dict):
        raise ValueError('计划必须为对象')
    return header, records, footer, plan


def validate_plan(args):
    return plan_check(*load_plan(args), args.require_complete)


def verify_sources(args):
    header, records, footer, plan = load_plan(args)
    check = plan_check(header, records, footer, plan)
    if not check['valid']:
        return check
    root = no_symlinks(header['sourceRoot']).resolve()
    paths = {path for asset in plan['assets'] for path in [*asset['sources'], *asset.get('dependencies', [])]}
    errors = []
    for path in sorted(paths):
        expected = records[path].get('sha256')
        if not expected:
            errors.append(f'{path}：缺少扫描摘要，请使用 --hash all 或取得完整源快照')
            continue
        try:
            if file_hash(root / path) != expected:
                errors.append(f'{path}：内容变化')
        except (OSError, ValueError) as error:
            errors.append(f'{path}：{error}')
    return {'valid': not errors, 'checked': len(paths), 'errors': errors}


def check_evidence(value, library_id=None):
    secret_fields = {'authorization', 'token', 'accesstoken', 'refreshtoken', 'bearertoken',
                     'serpentmcptoken', 'mcpsessionid', 'session', 'sessionid', 'password', 'secret'}
    if isinstance(value, dict):
        for key, child in value.items():
            normalized_key = re.sub(r'[^a-z0-9]', '', key.lower())
            if normalized_key in secret_fields:
                raise ValueError('证据含凭据或 transport session 字段，拒绝写入')
            if library_id is not None and normalized_key == 'libraryid' and child != library_id:
                raise ValueError('证据中的 libraryId 与计划不符')
            check_evidence(child, library_id)
    elif isinstance(value, list):
        for child in value:
            check_evidence(child, library_id)
    elif isinstance(value, str) and re.search(r'\bBearer\s+\S+', value, flags=re.I):
        raise ValueError('证据含 Bearer 凭据，拒绝写入')


def checkpoint(args):
    plan_path = no_symlinks(args.plan)
    plan = json.loads(plan_path.read_text(encoding='utf-8'))
    if not plan.get('libraryId') or not any(asset.get('key') == args.key for asset in plan.get('assets', [])):
        raise ValueError('检查点需要 libraryId 和计划内的资产 key')
    evidence_path = no_symlinks(args.evidence)
    evidence = json.loads(evidence_path.read_text(encoding='utf-8'))
    check_evidence(evidence, plan['libraryId'])
    event = {'recordType': 'event', 'version': 1, 'at': now(), 'libraryId': plan['libraryId'], 'key': args.key,
             'status': args.status, 'planSha256': value_hash(plan),
             'evidenceSha256': value_hash(evidence), 'evidence': evidence}
    out = output_path(args.out, [Path(plan['sourceRoot']).resolve()])
    if out.suffix.lower() != '.jsonl' or out in {plan_path, evidence_path}:
        raise ValueError('检查点应写入独立的 .jsonl 日志，不能覆盖计划或证据')
    if out.exists():
        with out.open(encoding='utf-8') as stream:
            for line in stream:
                previous = json.loads(line)
                if previous.get('recordType') != 'event' or previous.get('libraryId') != plan['libraryId']:
                    raise ValueError('检查点日志类型或目标库不符，拒绝追加')
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open('a', encoding='utf-8') as stream:
        stream.write(canonical(event) + '\n')
        stream.flush()
        os.fsync(stream.fileno())
    return {'out': str(out), 'key': args.key, 'status': args.status, 'evidenceSha256': event['evidenceSha256']}


def parser():
    cli = argparse.ArgumentParser(description=__doc__)
    commands = cli.add_subparsers(dest='command', required=True)
    command = commands.add_parser('scan', help='只读盘点图像/Shader 候选及范围外文件')
    command.add_argument('--source', required=True)
    command.add_argument('--out', required=True, help='新的持久记录目录，必须在原始目录之外')
    command.add_argument('--hash', choices=('none', 'candidates', 'all'), default='candidates')
    command.add_argument('--pixels', action='store_true', help='使用 Pillow 生成静态 raster 的同画布排重候选指纹')
    command = commands.add_parser('duplicates', help='输出本批与旧来源清单的候选，不自动合并')
    command.add_argument('--inventory', required=True)
    command.add_argument('--previous', action='append', default=[])
    command.add_argument('--out', required=True)
    for name, description in (('validate-plan', '检查计划范围、标签、命名与覆盖'), ('verify-sources', '重算计划涉及的原文件摘要')):
        command = commands.add_parser(name, help=description)
        command.add_argument('--inventory', required=True)
        command.add_argument('--plan', required=True)
        if name == 'validate-plan':
            command.add_argument('--require-complete', action='store_true')
    command = commands.add_parser('checkpoint', help='追加已发生的阶段事实；不会发送 MCP 或重试操作')
    command.add_argument('--plan', required=True)
    command.add_argument('--key', required=True)
    command.add_argument('--status', choices=STATUSES, required=True)
    command.add_argument('--evidence', required=True)
    command.add_argument('--out', required=True)
    return cli


def main():
    args = parser().parse_args()
    try:
        result = {'scan': scan, 'duplicates': duplicates, 'validate-plan': validate_plan,
                  'verify-sources': verify_sources, 'checkpoint': checkpoint}[args.command](args)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result.get('valid', True) and result.get('complete', True) else 1
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
