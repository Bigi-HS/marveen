"""
Unit tests for scripts/watch.py pure functions.
No network, no yt-dlp, no ffmpeg, no faster-whisper needed.
"""

import importlib.util
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

# ── Load the module without executing main() ──────────────────────────────────

_SCRIPT = Path(__file__).parent.parent / 'watch.py'
spec = importlib.util.spec_from_file_location('watch', _SCRIPT)
assert spec and spec.loader
_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(_mod)  # type: ignore

extract_video_id = _mod.extract_video_id
check_prerequisites = _mod.check_prerequisites
find_ffmpeg = _mod.find_ffmpeg
parse_vtt = _mod.parse_vtt
frame_budget_for_duration = _mod.frame_budget_for_duration
build_prompt_context = _mod.build_prompt_context
MODES = _mod.MODES
WHISPER_VENV_FFMPEG = _mod.WHISPER_VENV_FFMPEG


# ── extract_video_id ──────────────────────────────────────────────────────────

class TestExtractVideoId(unittest.TestCase):

    def test_bare_11_char_id(self):
        self.assertEqual(extract_video_id('iYG5tiFfK3E'), 'iYG5tiFfK3E')

    def test_youtube_watch_url(self):
        self.assertEqual(extract_video_id('https://www.youtube.com/watch?v=iYG5tiFfK3E'), 'iYG5tiFfK3E')

    def test_youtube_watch_url_with_extra_params(self):
        self.assertEqual(
            extract_video_id('https://www.youtube.com/watch?v=iYG5tiFfK3E&t=42s&list=PL123'),
            'iYG5tiFfK3E',
        )

    def test_youtu_be_shortlink(self):
        self.assertEqual(extract_video_id('https://youtu.be/iYG5tiFfK3E'), 'iYG5tiFfK3E')

    def test_youtu_be_with_params(self):
        self.assertEqual(extract_video_id('https://youtu.be/iYG5tiFfK3E?si=abc'), 'iYG5tiFfK3E')

    def test_shorts_url(self):
        self.assertEqual(extract_video_id('https://www.youtube.com/shorts/iYG5tiFfK3E'), 'iYG5tiFfK3E')

    def test_embed_url(self):
        self.assertEqual(extract_video_id('https://www.youtube.com/embed/iYG5tiFfK3E'), 'iYG5tiFfK3E')

    def test_invalid_raises(self):
        with self.assertRaises(ValueError):
            extract_video_id('not-a-video-url')

    def test_too_short_id_raises(self):
        with self.assertRaises(ValueError):
            extract_video_id('abc123')

    def test_id_with_underscore_and_hyphen(self):
        self.assertEqual(extract_video_id('aB3-d_fG7hK'), 'aB3-d_fG7hK')


# ── parse_vtt ─────────────────────────────────────────────────────────────────

class TestParseVtt(unittest.TestCase):

    SAMPLE_VTT = (
        'WEBVTT\n'
        'Kind: captions\n'
        '\n'
        '00:00:00.000 --> 00:00:02.000 align:start position:0%\n'
        '<c>Hello</c> world\n'
        '\n'
        '00:00:02.000 --> 00:00:04.000 align:start position:0%\n'
        'Hello world\n'
        '\n'
        '00:00:04.000 --> 00:00:06.000 align:start position:0%\n'
        'This is a test.\n'
        '\n'
    )

    def test_strips_webvtt_header(self):
        result = parse_vtt(self.SAMPLE_VTT)
        self.assertNotIn('WEBVTT', result)
        self.assertNotIn('Kind:', result)

    def test_strips_timecode_lines(self):
        result = parse_vtt(self.SAMPLE_VTT)
        self.assertNotIn('-->', result)

    def test_strips_inline_tags(self):
        result = parse_vtt(self.SAMPLE_VTT)
        self.assertNotIn('<c>', result)
        self.assertNotIn('</c>', result)

    def test_deduplicates_overlapping_lines(self):
        result = parse_vtt(self.SAMPLE_VTT)
        lines = [l for l in result.splitlines() if l.strip()]
        # 'Hello world' appears twice in vtt but must appear once in output
        self.assertEqual(lines.count('Hello world'), 1)

    def test_keeps_unique_lines(self):
        result = parse_vtt(self.SAMPLE_VTT)
        self.assertIn('Hello world', result)
        self.assertIn('This is a test.', result)

    def test_empty_vtt(self):
        self.assertEqual(parse_vtt(''), '')

    def test_vtt_no_content(self):
        result = parse_vtt('WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n\n')
        self.assertEqual(result.strip(), '')


# ── frame_budget_for_duration ─────────────────────────────────────────────────

class TestFrameBudget(unittest.TestCase):

    def test_hook_mode_caps_at_15s(self):
        # hook: 2fps, max 15s -> 30 frames
        budget = frame_budget_for_duration(600.0, 'hook')
        self.assertEqual(budget, 30)

    def test_short_mode_1fps(self):
        # short: 1fps, 60s -> 60 frames
        budget = frame_budget_for_duration(60.0, 'short')
        self.assertEqual(budget, 60)

    def test_medium_mode_1_per_5s(self):
        # medium: 1/5fps, 300s -> 60 frames
        budget = frame_budget_for_duration(300.0, 'medium')
        self.assertEqual(budget, 60)

    def test_long_mode_1_per_30s(self):
        # long: 1/30fps, 1800s -> 60 frames
        budget = frame_budget_for_duration(1800.0, 'long')
        self.assertEqual(budget, 60)

    def test_sparse_mode_1_per_60s(self):
        # sparse: 1/60fps, 3600s -> 60 frames
        budget = frame_budget_for_duration(3600.0, 'sparse')
        self.assertEqual(budget, 60)

    def test_minimum_1_frame(self):
        # very short video in sparse mode still yields at least 1
        budget = frame_budget_for_duration(1.0, 'sparse')
        self.assertGreaterEqual(budget, 1)

    def test_hook_mode_short_video(self):
        # 5s video in hook mode: 5s * 2fps = 10 frames
        budget = frame_budget_for_duration(5.0, 'hook')
        self.assertEqual(budget, 10)


# ── find_ffmpeg ───────────────────────────────────────────────────────────────

class TestFindFfmpeg(unittest.TestCase):

    def test_returns_none_when_both_missing(self):
        with patch('shutil.which', return_value=None), \
             patch('os.path.isfile', return_value=False):
            self.assertIsNone(find_ffmpeg())

    def test_prefers_path_ffmpeg(self):
        with patch('shutil.which', return_value='/usr/bin/ffmpeg'):
            result = find_ffmpeg()
            self.assertEqual(result, '/usr/bin/ffmpeg')

    def test_falls_back_to_whisper_venv(self):
        with patch('shutil.which', return_value=None), \
             patch('os.path.isfile', return_value=True), \
             patch('os.access', return_value=True):
            result = find_ffmpeg()
            self.assertEqual(result, WHISPER_VENV_FFMPEG)

    def test_whisper_venv_ffmpeg_path_contains_store(self):
        self.assertIn('store', WHISPER_VENV_FFMPEG)
        self.assertIn('whisper-env', WHISPER_VENV_FFMPEG)
        self.assertTrue(WHISPER_VENV_FFMPEG.endswith('ffmpeg'))


# ── MODES constants ───────────────────────────────────────────────────────────

class TestModes(unittest.TestCase):

    def test_all_required_modes_present(self):
        for mode in ('hook', 'short', 'medium', 'long', 'sparse'):
            self.assertIn(mode, MODES)

    def test_hook_has_2fps_rate(self):
        rate, max_s, _ = MODES['hook']
        self.assertEqual(rate, '2')
        self.assertEqual(max_s, 15)

    def test_medium_has_1_per_5s_rate(self):
        rate, max_s, _ = MODES['medium']
        self.assertEqual(rate, '1/5')
        self.assertIsNone(max_s)

    def test_scale_is_640_wide(self):
        for mode, (_, _, scale) in MODES.items():
            self.assertTrue(scale.startswith('640'), f'mode {mode} scale should be 640-wide: {scale}')


# ── build_prompt_context ──────────────────────────────────────────────────────

class TestBuildPromptContext(unittest.TestCase):

    def setUp(self):
        import tempfile
        self.tmpdir = Path(tempfile.mkdtemp())
        self.transcript = self.tmpdir / 'transcript.txt'
        self.transcript.write_text('[0.0s] Hello world\n[5.2s] This is the content.\n')

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _fake_frames(self, names):
        frames = []
        for name in names:
            p = self.tmpdir / name
            p.touch()
            frames.append(p)
        return frames

    def test_includes_video_id(self):
        frames = self._fake_frames(['00-00-05.jpg', '00-00-10.jpg'])
        ctx_path = build_prompt_context('iYG5tiFfK3E', frames, self.transcript, 'yt-dlp auto-captions', 'What is shown?', self.tmpdir)
        content = ctx_path.read_text()
        self.assertIn('iYG5tiFfK3E', content)

    def test_includes_transcript_content(self):
        frames = self._fake_frames(['00-00-05.jpg'])
        ctx_path = build_prompt_context('iYG5tiFfK3E', frames, self.transcript, 'yt-dlp auto-captions', 'What is shown?', self.tmpdir)
        content = ctx_path.read_text()
        self.assertIn('Hello world', content)

    def test_includes_question(self):
        frames = self._fake_frames(['00-00-05.jpg'])
        ctx_path = build_prompt_context('iYG5tiFfK3E', frames, self.transcript, 'yt-dlp auto-captions', 'What technique is used?', self.tmpdir)
        content = ctx_path.read_text()
        self.assertIn('What technique is used?', content)

    def test_includes_transcript_method(self):
        frames = self._fake_frames(['00-00-05.jpg'])
        ctx_path = build_prompt_context('iYG5tiFfK3E', frames, self.transcript, 'faster-whisper (local)', 'Q?', self.tmpdir)
        content = ctx_path.read_text()
        self.assertIn('faster-whisper (local)', content)

    def test_includes_frame_filenames(self):
        frames = self._fake_frames(['00-00-05.jpg', '00-00-10.jpg', '00-00-15.jpg'])
        ctx_path = build_prompt_context('iYG5tiFfK3E', frames, self.transcript, 'yt-dlp auto-captions', 'Q?', self.tmpdir)
        content = ctx_path.read_text()
        self.assertIn('00-00-05.jpg', content)
        self.assertIn('00-00-15.jpg', content)

    def test_includes_hh_mm_ss_instruction(self):
        frames = self._fake_frames(['00-00-05.jpg'])
        ctx_path = build_prompt_context('iYG5tiFfK3E', frames, self.transcript, 'yt-dlp auto-captions', 'Q?', self.tmpdir)
        content = ctx_path.read_text()
        self.assertIn('HH-MM-SS', content)

    def test_frame_count_in_context(self):
        frames = self._fake_frames(['00-00-05.jpg', '00-00-10.jpg'])
        ctx_path = build_prompt_context('iYG5tiFfK3E', frames, self.transcript, 'yt-dlp auto-captions', 'Q?', self.tmpdir)
        content = ctx_path.read_text()
        self.assertIn('2 frames', content)

    def test_zero_frames_graceful(self):
        ctx_path = build_prompt_context('iYG5tiFfK3E', [], self.transcript, 'yt-dlp auto-captions', 'Q?', self.tmpdir)
        content = ctx_path.read_text()
        self.assertIn('0 frames', content)


if __name__ == '__main__':
    unittest.main()
