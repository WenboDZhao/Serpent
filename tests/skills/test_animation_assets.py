"""Run with ASEPRITE_BIN set; Pillow is used only as an independent PNG/GIF verifier."""
import importlib.util
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zlib

from PIL import Image

PROJECT = Path(__file__).resolve().parents[2]
SCRIPT = PROJECT / '.agents/skills/aseprite-animation-assets/scripts/assets.py'
spec = importlib.util.spec_from_file_location('animation_assets', SCRIPT)
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)
BIN = os.environ.get('ASEPRITE_BIN')


def decode_aseprite(file):
    data = Path(file).read_bytes()
    count = struct.unpack_from('<H', data, 6)[0]
    frames = []
    position = 128
    for index in range(count):
        size, magic, chunks, duration = struct.unpack_from('<IHHH', data, position)
        assert magic == 0xF1FA
        new_chunks = struct.unpack_from('<I', data, position + 12)[0]
        cursor = position + 16
        cels = []
        for _ in range(new_chunks or chunks):
            chunk_size, kind = struct.unpack_from('<IH', data, cursor)
            payload = data[cursor + 6:cursor + chunk_size]
            if kind == 0x2005:
                layer, x, y, opacity, cel_type = struct.unpack_from('<HhhBH', payload)
                if cel_type in (0, 2):
                    width, height = struct.unpack_from('<HH', payload, 16)
                    raw = zlib.decompress(payload[20:]) if cel_type == 2 else payload[20:]
                    cels.append(dict(layer=layer, x=x, y=y, width=width, height=height, pixels=raw, opacity=opacity))
                elif cel_type == 1:
                    linked = struct.unpack_from('<H', payload, 16)[0]
                    cel = dict(next(cel for cel in frames[linked]['cels'] if cel['layer'] == layer))
                    cel.update(x=x, y=y, opacity=opacity)
                    cels.append(cel)
            cursor += chunk_size
        frames.append(dict(duration=duration, cels=cels))
        position += size
    return frames


@unittest.skipUnless(BIN, 'ASEPRITE_BIN is required for real Aseprite conversion checks')
class ConversionTests(unittest.TestCase):
    def test_numbered_pngs_with_different_sizes_keep_explicit_cel_bounds(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            small = Image.new('RGBA', (2, 2), (210, 20, 30, 255))
            large = Image.new('RGBA', (5, 4), (20, 190, 70, 127))
            small.save(root / 'frame01.png'); large.save(root / 'frame02.png')
            manifest = dict(name='numbered.aseprite', canvas=dict(width=6, height=6), layers=[dict(name='body')],
                            frames=[dict(durationMs=100, cels=[dict(layer=1, path=str(root/'frame01.png'), position=dict(x=4,y=4))]),
                                    dict(durationMs=140, cels=[dict(layer=1, path=str(root/'frame02.png'), position=dict(x=0,y=0))])],
                            actions=[dict(name='motion', **{'from':1,'to':2})])
            recipe = dict(version=1,actions=[dict(name='motion',frames=[1,2],durationsMs=[100,140])],
                          combinations=[dict(name='original')],crop=dict(x=0,y=0,width=6,height=6),
                          layout=dict(columns=1,scale=1,padding=0),posterFrame=0)
            assets.write_json(root/'manifest.json',manifest); assets.write_json(root/'recipe.json',recipe)
            result = subprocess.run([os.sys.executable,str(SCRIPT),'prepare','--aseprite',BIN,'--manifest',str(root/'manifest.json'),
                                     '--recipe',str(root/'recipe.json'),'--work-parent',str(root)],check=True,text=True,capture_output=True)
            run=assets.load_run(json.loads(result.stdout)['run'])
            frames=decode_aseprite(Path(run['root'])/run['sourceName'])
            self.assertEqual([frame['duration'] for frame in frames],[100,140])
            for frame,image,position in zip(frames,[small,large],[(4,4),(0,0)]):
                self.assertEqual(len(frame['cels']),1)
                cel=frame['cels'][0]
                self.assertEqual((cel['x'],cel['y']),position)
                self.assertEqual((cel['width'],cel['height']),image.size)
                self.assertEqual(cel['pixels'],image.tobytes())
            with Image.open(root/'frame01.png') as original:
                self.assertEqual(original.size,(2,2))

    def test_multiple_png_and_sheet_preserve_rgba_position_order_and_timing(self):
        for use_sheet in (False, True):
            with self.subTest(use_sheet=use_sheet), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                frames = []
                for i, color in enumerate(((255, 10, 20, 255), (20, 255, 30, 255))):
                    image = Image.new('RGBA', (3, 2))
                    image.putpixel((0, 0), color)
                    image.putpixel((2, 1), (10, 30, 200, 127))
                    image.save(root / f'frame-{i}.png')
                    frames.append(image)
                sheet = Image.new('RGBA', (6, 2))
                for i, frame in enumerate(frames):
                    sheet.paste(frame, (i * 3, 0))
                sheet.save(root / 'sheet.png')
                part = Image.new('RGBA', (1, 1), (40, 50, 60, 255)); part.save(root / 'part.png')
                manifest = dict(name='sample.aseprite', canvas=dict(width=6, height=6), layers=[dict(name='body'), dict(name='part')],
                                frames=[dict(durationMs=duration, cels=[dict(layer=1, path=str(root / ('sheet.png' if use_sheet else f'frame-{i}.png')),
                                 **(dict(rect=dict(x=3*i, y=0, width=3, height=2)) if use_sheet else {}), position=dict(x=1, y=2)),
                                 dict(layer=2,path=str(root / 'part.png'),position=dict(x=4,y=4))]) for i, duration in enumerate((75,125))],
                                actions=[dict(name='idle', **{'from':1, 'to':2})])
                recipe = dict(version=1, actions=[dict(name='idle', frames=[1,2], durationsMs=[75,125])], combinations=[dict(name='body')],
                              crop=dict(x=0,y=0,width=6,height=6), layout=dict(columns=1,scale=1,padding=0),posterFrame=0)
                assets.write_json(root / 'manifest.json', manifest)
                assets.write_json(root / 'recipe.json', recipe)
                result = subprocess.run([str(Path(os.sys.executable)), str(SCRIPT), 'prepare', '--aseprite', BIN, '--manifest', str(root / 'manifest.json'), '--recipe', str(root / 'recipe.json'), '--work-parent', str(root)], check=True, text=True, capture_output=True)
                run = assets.load_run(json.loads(result.stdout)['run'])
                decoded = decode_aseprite(Path(run['root']) / run['sourceName'])
                self.assertEqual([frame['duration'] for frame in decoded], [75,125])
                for i, frame in enumerate(decoded):
                    cel = frame['cels'][0]
                    self.assertEqual((cel['x'],cel['y'],cel['width'],cel['height']), (1,2,3,2))
                    self.assertEqual(cel['pixels'], frames[i].tobytes())
                    self.assertEqual(len(frame['cels']), 2)
                    self.assertEqual(frame['cels'][1]['pixels'], part.tobytes())
                    self.assertEqual((frame['cels'][1]['x'],frame['cels'][1]['y']), (4,4))
                gif = Image.open(Path(run['root']) / 'preview.gif')
                self.assertEqual(gif.n_frames, 2)
                durations = []
                for i in range(2):
                    gif.seek(i); durations.append(gif.info['duration'])
                    self.assertEqual(gif.convert('RGBA').getpixel((1,2)), frames[i].getpixel((0,0)))
                    self.assertEqual(gif.convert('RGBA').getpixel((0,0))[3], 0)
                    self.assertEqual(gif.convert('RGBA').getpixel((4,4)), part.getpixel((0,0)))
                self.assertEqual(sum(durations), 200)
                self.assertEqual(len(list(Path(run['root']).glob('*.gif'))), 1)
                gif.close()


class LifecycleTests(unittest.TestCase):
    def make_run(self, parent):
        run = assets.new_run(parent)
        (Path(run['root']) / 'temporary.txt').write_text('temporary')
        run['phase'] = 'verified'; assets.save_run(run)
        return run

    def test_cleanup_checks_entire_tree_before_removing_anything(self):
        with tempfile.TemporaryDirectory() as directory:
            run = self.make_run(directory); root = Path(run['root'])
            outside = Path(directory) / 'original.png'; outside.write_bytes(b'original')
            (root / 'unsafe').symlink_to(outside)
            with self.assertRaises(AssertionError): assets.cleanup(run)
            self.assertTrue((root / 'temporary.txt').exists()); self.assertEqual(outside.read_bytes(), b'original')
            (root / 'unsafe').unlink(); assets.cleanup(run)
            self.assertFalse(root.exists()); self.assertTrue(outside.exists())

    def test_cleanup_failure_retains_ownership_and_recovery_state(self):
        with tempfile.TemporaryDirectory() as directory:
            run = self.make_run(directory)
            with patch.object(assets.shutil, 'rmtree', side_effect=PermissionError('locked')):
                with self.assertRaises(PermissionError): assets.cleanup(run)
            self.assertEqual(assets.load_run(run['root'])['phase'], 'cleanup-failed')

    def test_cleanup_rejects_unverified_runs_and_escaped_roots(self):
        with tempfile.TemporaryDirectory() as directory:
            run = self.make_run(directory); run['phase']='failed'; assets.save_run(run)
            with self.assertRaises(AssertionError): assets.cleanup(run)
            run['root'] = directory
            with self.assertRaises((AssertionError, FileNotFoundError)): assets.cleanup(run)

    def test_unchanged_update_does_not_allocate_or_render(self):
        recipe = dict(version=1,actions=[dict(name='idle',frames=[1],durationsMs=[80])],combinations=[dict(name='body')],crop=dict(x=0,y=0,width=1,height=1),layout=dict(columns=1,scale=1,padding=0),posterFrame=0)
        info = dict(recipe=recipe, previewMissing=False, sourceSha256='a'*64,generation=dict(sourceSha256='a'*64,recipeSha256=assets.json_hash(recipe),generatorVersion='same'))
        args = type('Args', (), dict(library='lib',asset='asset',recipe=None,aseprite='aseprite'))()
        with patch.object(assets,'Mcp') as client, patch.object(assets,'generator_version',return_value='same'), patch.object(assets,'new_run') as new_run:
            client.return_value.call.return_value=info
            assets.update(args)
            new_run.assert_not_called()

    def test_resume_publishes_new_source_even_when_preview_bytes_are_unchanged(self):
        recipe = dict(version=1,actions=[dict(name='idle',frames=[1],durationsMs=[100])],combinations=[dict(name='body')],crop=dict(x=0,y=0,width=1,height=1),layout=dict(columns=1,scale=1,padding=0),posterFrame=0)
        with tempfile.TemporaryDirectory() as directory:
            run = assets.new_run(directory); root = Path(run['root'])
            (root/'source.aseprite').write_bytes(b'new source with an additional hidden layer')
            (root/'preview.gif').write_bytes(b'unchanged preview bytes')
            assets.write_json(root/'recipe.json',recipe)
            run.update(mode='update',libraryId='lib',assetId='asset',sourceName='source.aseprite',sourceSha256=assets.digest(root/'source.aseprite'),sourceRevisionId='revision-new',previewSha256=assets.digest(root/'preview.gif'),generatorVersion='same')
            assets.save_run(run)
            info = dict(previewMissing=False,sourceSha256=run['sourceSha256'],generation=dict(sourceSha256='a'*64,sourceRevisionId='revision-old',previewSha256=run['previewSha256'],recipeSha256=assets.json_hash(recipe),generatorVersion='same'))
            args = type('Args', (), dict(run=run['root'],keep_work=True))()
            with patch.object(assets,'Mcp') as client, patch.object(assets,'finish') as finish:
                client.return_value.call.return_value=info
                assets.resume_run(args,run)
                calls=client.return_value.call.call_args_list
                stage=next(call for call in calls if call.args[0]=='serpent_animation_preview_stage')
                self.assertEqual(stage.kwargs['expectedRevisionId'],'revision-new')
                self.assertEqual(stage.kwargs['expectedSourceSha256'],run['sourceSha256'])
                self.assertTrue(any(call.args[0]=='serpent_animation_preview_publish' for call in calls))
                finish.assert_called_once()


if __name__ == '__main__':
    unittest.main()
