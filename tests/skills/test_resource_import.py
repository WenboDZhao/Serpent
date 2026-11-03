"""隔离验证资源整理 Skill；只操作临时样本，不连接生产 MCP。"""

import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zlib


PROJECT = Path(__file__).resolve().parents[2]
SCRIPT = PROJECT / '.agents/skills/serpent-resource-import/scripts/catalog.py'
SPEC = importlib.util.spec_from_file_location('resource_catalog', SCRIPT)
catalog = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(catalog)

try:
    from PIL import Image
except ImportError:
    Image = None


def png(color=(20, 40, 60, 255), compression=6):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))

    row = b'\0' + bytes(color) * 8
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 8, 1, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(row, compression)) + chunk(b'IEND', b''))


class ResourceImportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='serpent-resource-skill-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.source = self.root / 'originals'
        self.source.mkdir()
        self.write('Pack/Boar.png', png())

    def write(self, relative, content):
        path = self.source / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return path

    def scan(self, pixels=False):
        out = self.root / f'records-{len(list(self.root.glob("records-*")))}'
        result = catalog.scan(argparse.Namespace(source=str(self.source), out=str(out), hash='all', pixels=pixels))
        return out, result

    def plan(self):
        return {'version': 1, 'sourceRoot': str(self.source), 'libraryId': 'test-library',
                'defaultFrameDurationMs': 100, 'assets': [
                    {'key': 'pack/boar', 'kind': 'image', 'operation': 'import', 'name': 'Boar.png',
                     'sources': ['Pack/Boar.png'], 'dependencies': [], 'folder': ['Pack', '动物'],
                     'tags': ['图像', '素材包/Pack', '类型/动物', '动物/野猪'], 'reason': '独立的野猪图像'}],
                'dispositions': []}

    def test_scope_keeps_images_in_engine_projects_and_shader_exception(self):
        expected = {
            'Unity/Assets/Hero.png': 'image', 'Godot/art/hero.aseprite': 'image',
            'Unity/Assets/Water.shader': 'shader', 'Unity/Assets/Water.shadergraph': 'shader',
            'Unity/Assets/Water.compute': 'shader',
            'Godot/Water.gdshader': 'shader', 'common/math.hlsli': 'shader',
            'Godot/.godot/imported/cover.png': 'excluded', 'Scene.unity': 'excluded',
            'Actor.prefab': 'excluded', 'scene.tscn': 'excluded', 'material.tres': 'excluded',
            'hero.gd': 'excluded', 'Hero.cs': 'excluded', 'mesh.fbx': 'excluded',
            'sound.wav': 'excluded', 'movie.mp4': 'excluded', 'font.ttf': 'excluded',
            'Sprite.png.meta': 'auxiliary', 'Sprite.json': 'auxiliary', 'LICENSE': 'auxiliary',
            'archive.zip': 'archive', '._image.psd': 'excluded', 'mystery.bin': 'pending',
        }
        for path, role in expected.items():
            with self.subTest(path=path):
                self.assertEqual(catalog.classify(path)[0], role)

    def test_scan_preserves_originals_and_records_scope_and_wrong_extension(self):
        self.write('Pack/frame.json', b'{"duration":100}')
        self.write('Pack/water.shader', b'Shader "Water" {}')
        self.write('Pack/audio.wav', b'RIFF audio')
        self.write('Pack/wrong.bin', png())
        before = {str(path): path.read_bytes() for path in self.source.rglob('*') if path.is_file()}
        out, summary = self.scan()
        header, records, footer = catalog.load_inventory(out / 'inventory.jsonl')
        self.assertEqual(header['sourceRoot'], str(self.source))
        self.assertTrue(summary['complete'] and footer['complete'])
        self.assertEqual(summary['files'], 5)
        self.assertEqual(records['Pack/wrong.bin']['role'], 'pending')
        self.assertEqual(records['Pack/wrong.bin']['detectedExtension'], '.png')
        self.assertEqual(records['Pack/audio.wav']['role'], 'excluded')
        self.assertEqual(records['Pack/Boar.png']['sha256'], hashlib.sha256(png()).hexdigest())
        self.assertEqual(before, {str(path): path.read_bytes() for path in self.source.rglob('*') if path.is_file()})

    def test_source_and_output_symlinks_are_not_followed(self):
        outside = self.root / 'outside.png'
        outside.write_bytes(png())
        (self.source / 'linked.png').symlink_to(outside)
        out, _ = self.scan()
        _, records, _ = catalog.load_inventory(out / 'inventory.jsonl')
        self.assertEqual(records['linked.png']['role'], 'pending')
        self.assertNotIn('sha256', records['linked.png'])
        (self.root / 'redirect').symlink_to(self.source, target_is_directory=True)
        with self.assertRaises(ValueError):
            catalog.scan(argparse.Namespace(source=str(self.source), out=str(self.root / 'redirect/new'), hash='all', pixels=False))
        with self.assertRaises(ValueError):
            catalog.scan(argparse.Namespace(source=str(self.source), out=str(self.source / 'records'), hash='all', pixels=False))
        self.assertFalse((self.source / 'records').exists())

    def test_scan_detects_source_change_and_drops_unreliable_digest(self):
        original = catalog.file_hash

        def change_after_hash(path):
            digest = original(path)
            path.write_bytes(png((10, 20, 30, 255)))
            return digest

        with patch.object(catalog, 'file_hash', side_effect=change_after_hash):
            out, summary = self.scan()
        _, records, _ = catalog.load_inventory(out / 'inventory.jsonl')
        self.assertFalse(summary['complete'])
        self.assertEqual(records['Pack/Boar.png']['role'], 'error')
        self.assertNotIn('sha256', records['Pack/Boar.png'])

    @unittest.skipUnless(Image, '像素指纹样本需要 Pillow')
    def test_pixel_candidates_respect_canvas_alpha_and_animated_inputs(self):
        self.write('Pack/reencoded.png', png(compression=0))
        self.write('Pack/red.png', png((200, 20, 30, 255)))
        self.write('Pack/transparent-a.png', png((10, 20, 30, 0)))
        self.write('Pack/transparent-b.png', png((30, 20, 10, 0)))
        frames = [Image.new('RGBA', (8, 1), color) for color in ('red', 'blue')]
        frames[0].save(self.source / 'Pack/animated.png', save_all=True, append_images=frames[1:], duration=100)
        out, _ = self.scan(pixels=True)
        _, records, _ = catalog.load_inventory(out / 'inventory.jsonl')
        a, b = records['Pack/Boar.png'], records['Pack/reencoded.png']
        self.assertNotEqual(a['sha256'], b['sha256'])
        self.assertEqual(a['pixelSha256'], b['pixelSha256'])
        self.assertNotEqual(a['pixelSha256'], records['Pack/red.png']['pixelSha256'])
        self.assertEqual(records['Pack/transparent-a.png']['pixelSha256'], records['Pack/transparent-b.png']['pixelSha256'])
        self.assertEqual(records['Pack/animated.png']['frames'], 2)
        self.assertNotIn('pixelSha256', records['Pack/animated.png'])

    def test_duplicate_candidates_include_old_inventory_without_claiming_import(self):
        self.write('Pack/copy.png', png())
        out, _ = self.scan()
        old = self.root / 'old.json'
        old.write_text(json.dumps({'sourceRoot': str(self.root / 'previous-source'), 'files': [
            {'relative': 'old/Boar.png', 'sha256': hashlib.sha256(png()).hexdigest()}]}))
        candidates = self.root / 'candidates.jsonl'
        result = catalog.duplicates(argparse.Namespace(inventory=str(out / 'inventory.jsonl'), previous=[str(old)], out=str(candidates)))
        groups = [json.loads(line) for line in candidates.read_text().splitlines()]
        self.assertEqual(result['groups']['sha256'], 1)
        self.assertEqual(len(groups[0]['members']), 3)
        self.assertTrue(groups[0]['candidateOnly'])
        self.assertFalse(any('assetId' in member for member in groups[0]['members']))
        with self.assertRaises(FileExistsError):
            catalog.duplicates(argparse.Namespace(inventory=str(out / 'inventory.jsonl'), previous=[], out=str(candidates)))

    def test_incomplete_inventory_cannot_be_used_for_validation(self):
        out, _ = self.scan()
        inventory = out / 'inventory.jsonl'
        lines = inventory.read_text().splitlines()
        inventory.write_text('\n'.join(lines[:-1]) + '\n')
        with self.assertRaises(ValueError):
            catalog.load_inventory(inventory)

    def test_plan_checks_coverage_and_distinguishes_pending_from_complete(self):
        self.write('unknown.zip', b'archive')
        self.write('unrelated.fbx', b'model')
        self.write('info.json', b'{}')
        out, _ = self.scan()
        header, records, footer = catalog.load_inventory(out / 'inventory.jsonl')
        plan = self.plan()
        self.assertFalse(catalog.plan_check(header, records, footer, plan)['valid'])
        plan['dispositions'] = [{'path': 'unknown.zip', 'action': 'pending', 'reason': '需检查目录'}]
        self.assertTrue(catalog.plan_check(header, records, footer, plan)['valid'])
        self.assertFalse(catalog.plan_check(header, records, footer, plan, True)['valid'])

    def test_plan_rejects_nonimage_sources_bad_tags_and_unsafe_names(self):
        self.write('mesh.fbx', b'model')
        out, _ = self.scan()
        inputs = catalog.load_inventory(out / 'inventory.jsonl')
        changes = [
            {'sources': ['mesh.fbx']}, {'name': '../Boar.png'}, {'folder': ['..']},
            {'name': 'Boar2.png'}, {'name': 'Boar (2).png'}, {'tags': ['图像']},
            {'name': 'CON.png'}, {'folder': ['bad:name']},
            {'operation': 'reuse'}, {'kind': 'animation', 'name': 'Boar.gif'},
        ]
        for change in changes:
            with self.subTest(change=change):
                plan = self.plan()
                plan['assets'][0].update(change)
                self.assertFalse(catalog.plan_check(*inputs, plan)['valid'])
        self.assertEqual(catalog.safe_static_name('Boar (2).png'), 'Boar (2)_static.png')

    def test_shader_plan_keeps_true_extension_and_image_labels_separate(self):
        self.write('water.gdshader', b'shader_type canvas_item;')
        out, _ = self.scan()
        inputs = catalog.load_inventory(out / 'inventory.jsonl')
        plan = self.plan()
        shader = {'key': 'pack/water', 'kind': 'shader', 'operation': 'import', 'name': 'water.gdshader',
                  'sources': ['water.gdshader'], 'folder': ['Pack', 'Shader'], 'reason': '水面 Shader',
                  'tags': ['Shader', '素材包/Pack', 'Shader/水面', '引擎/Godot']}
        plan['assets'].append(shader)
        self.assertTrue(catalog.plan_check(*inputs, plan)['valid'])
        shader['tags'].append('动物/鱼')
        self.assertFalse(catalog.plan_check(*inputs, plan)['valid'])
        shader['tags'].remove('动物/鱼')
        shader['name'] = 'water.png'
        self.assertFalse(catalog.plan_check(*inputs, plan)['valid'])

    def test_target_collision_and_invalid_duplicate_reference_are_detected(self):
        self.write('Pack/copy.png', png())
        out, _ = self.scan()
        inputs = catalog.load_inventory(out / 'inventory.jsonl')
        plan = self.plan()
        extra = copy.deepcopy(plan['assets'][0])
        extra.update(key='pack/other', name='boar.png', sources=['Pack/copy.png'])
        plan['assets'].append(extra)
        self.assertFalse(catalog.plan_check(*inputs, plan)['valid'])
        plan['assets'].pop()
        plan['dispositions'] = [{'path': 'Pack/copy.png', 'action': 'duplicate', 'assetKey': 'missing', 'reason': 'same pixels'}]
        self.assertFalse(catalog.plan_check(*inputs, plan)['valid'])
        plan['dispositions'][0]['assetKey'] = 'pack/boar'
        self.assertTrue(catalog.plan_check(*inputs, plan)['valid'])

    def test_source_verification_catches_changes_and_missing_hashes(self):
        out, _ = self.scan()
        plan_path = out / 'plan.json'
        plan_path.write_text(json.dumps(self.plan()))
        args = argparse.Namespace(inventory=str(out / 'inventory.jsonl'), plan=str(plan_path))
        self.assertTrue(catalog.verify_sources(args)['valid'])
        self.write('Pack/Boar.png', png((100, 30, 40, 255)))
        self.assertFalse(catalog.verify_sources(args)['valid'])
        other = self.root / 'without-hashes'
        catalog.scan(argparse.Namespace(source=str(self.source), out=str(other), hash='none', pixels=False))
        args.inventory = str(other / 'inventory.jsonl')
        self.assertFalse(catalog.verify_sources(args)['valid'])

    def test_checkpoint_retains_exact_request_and_rejects_credentials_or_other_files(self):
        plan_path, evidence = self.root / 'plan.json', self.root / 'request.json'
        plan_path.write_text(json.dumps(self.plan()))
        request = {'tool': 'serpent_file_import', 'arguments': {'libraryId': 'test-library', 'idempotencyKey': 'stable-key', 'sourcePaths': ['/scratch/Boar.png']}}
        evidence.write_text(json.dumps(request))
        out = self.root / 'events.jsonl'
        args = argparse.Namespace(plan=str(plan_path), evidence=str(evidence), out=str(out), key='pack/boar', status='submitted')
        catalog.checkpoint(args)
        args.status = 'failed'
        catalog.checkpoint(args)
        events = [json.loads(line) for line in out.read_text().splitlines()]
        self.assertEqual([event['status'] for event in events], ['submitted', 'failed'])
        self.assertEqual(events[0]['evidence'], request)
        for secret in ({'headers': {'Authorization': 'Bearer private'}}, {'session_id': 'private'}, {'message': 'Bearer private'}):
            evidence.write_text(json.dumps(secret))
            with self.assertRaises(ValueError):
                catalog.checkpoint(args)
        self.assertEqual(len(out.read_text().splitlines()), 2)
        evidence.write_text(json.dumps(request))
        args.out = str(plan_path)
        with self.assertRaises(ValueError):
            catalog.checkpoint(args)
        self.assertEqual(json.loads(plan_path.read_text()), self.plan())

    def test_checkpoint_rejects_evidence_from_a_different_library(self):
        plan_path, evidence = self.root / 'plan.json', self.root / 'request.json'
        plan_path.write_text(json.dumps(self.plan()))
        evidence.write_text(json.dumps({'arguments': {'libraryId': 'wrong-library'}}))
        out = self.root / 'events.jsonl'
        args = argparse.Namespace(plan=str(plan_path), evidence=str(evidence), out=str(out), key='pack/boar', status='submitted')
        with self.assertRaises(ValueError):
            catalog.checkpoint(args)
        self.assertFalse(out.exists())

    def test_checkpoint_cannot_append_to_inventory_or_other_library(self):
        out, _ = self.scan()
        plan_path, evidence = self.root / 'plan.json', self.root / 'request.json'
        plan_path.write_text(json.dumps(self.plan()))
        evidence.write_text('{}')
        args = argparse.Namespace(plan=str(plan_path), evidence=str(evidence), out=str(out / 'inventory.jsonl'), key='pack/boar', status='prepared')
        before = (out / 'inventory.jsonl').read_bytes()
        with self.assertRaises(ValueError):
            catalog.checkpoint(args)
        self.assertEqual((out / 'inventory.jsonl').read_bytes(), before)
        args.out = str(self.root / 'events.jsonl')
        catalog.checkpoint(args)
        plan = self.plan()
        plan['libraryId'] = 'another-library'
        plan_path.write_text(json.dumps(plan))
        with self.assertRaises(ValueError):
            catalog.checkpoint(args)

    def test_cli_scan_and_validation_return_machine_readable_results(self):
        out = self.root / 'cli-records'
        result = subprocess.run([sys.executable, str(SCRIPT), 'scan', '--source', str(self.source), '--out', str(out)], text=True, capture_output=True, check=True)
        self.assertTrue(json.loads(result.stdout)['complete'])
        plan_path = out / 'plan.json'
        plan_path.write_text(json.dumps(self.plan()))
        command = [sys.executable, str(SCRIPT), 'validate-plan', '--inventory', str(out / 'inventory.jsonl'), '--plan', str(plan_path), '--require-complete']
        result = subprocess.run(command, text=True, capture_output=True, check=True)
        self.assertTrue(json.loads(result.stdout)['valid'])
        plan = self.plan()
        plan['assets'][0]['sources'] = ['missing.png']
        plan_path.write_text(json.dumps(plan))
        result = subprocess.run(command, text=True, capture_output=True)
        self.assertEqual(result.returncode, 1)
        self.assertFalse(json.loads(result.stdout)['valid'])


if __name__ == '__main__':
    unittest.main()
