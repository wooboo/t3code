"""Verify provider requests without credentials or paid synthesis."""
import importlib.util
import json
import os
from pathlib import Path
import unittest

import httpx

os.environ['VOICE_COMPARE_TTS_VOICE'] = 'test-fixed-voice'
spec = importlib.util.spec_from_file_location('eleven_proxy', Path(__file__).with_name('elevenlabs-tts-server.py'))
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)


class SpeechTests(unittest.IsolatedAsyncioTestCase):
    async def test_same_voice_for_different_languages_and_preserves_pcm(self):
        requests = []

        def upstream(request):
            requests.append(request)
            return httpx.Response(200, content=b'\x01\x00\x02\x00')

        async with httpx.AsyncClient(base_url='https://api.elevenlabs.io', transport=httpx.MockTransport(upstream)) as provider:
            proxy.app.state.client = provider
            async with httpx.AsyncClient(base_url='http://test', transport=httpx.ASGITransport(app=proxy.app)) as client:
                for text in ['Dzień dobry.', 'Hello there.']:
                    response = await client.post('/v1/audio/speech', json={'input': text, 'voice': 'test-fixed-voice'})
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.content, b'\x01\x00\x02\x00')
                invalid = await client.post('/v1/audio/speech', json={'input': 'Hello', 'voice': 'wrong'})
                self.assertEqual(invalid.status_code, 400)
        self.assertEqual(len(requests), 2)
        for request in requests:
            self.assertEqual(request.url.path, '/v1/text-to-speech/test-fixed-voice/stream')
            self.assertNotIn('language_code', json.loads(request.content))
            self.assertEqual(request.url.params['output_format'], 'pcm_16000')

    async def test_provider_error_is_reported(self):
        async with httpx.AsyncClient(base_url='https://api.elevenlabs.io', transport=httpx.MockTransport(lambda _: httpx.Response(401))) as provider:
            proxy.app.state.client = provider
            async with httpx.AsyncClient(base_url='http://test', transport=httpx.ASGITransport(app=proxy.app)) as client:
                response = await client.post('/v1/audio/speech', json={'input': 'Hello'})
                self.assertEqual(response.status_code, 502)


if __name__ == '__main__':
    unittest.main()
