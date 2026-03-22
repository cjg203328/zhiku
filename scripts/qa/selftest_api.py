from __future__ import annotations

import json
import base64
import os
import shutil
import subprocess
import sys
from pathlib import Path


def run() -> dict:
    repo_root = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(repo_root / 'services' / 'api' / 'src'))

    base_dir = repo_root / '.tmp_selftest'
    shutil.rmtree(base_dir, ignore_errors=True)
    app_dir = base_dir / 'app'
    knowledge_dir = base_dir / 'library'
    app_dir.mkdir(parents=True, exist_ok=True)
    knowledge_dir.mkdir(parents=True, exist_ok=True)

    os.environ['ZHIKU_APP_DATA_DIR'] = str(app_dir)
    os.environ['ZHIKU_KNOWLEDGE_BASE_DIR'] = str(knowledge_dir)

    from zhiku_api.config import get_settings

    get_settings.cache_clear()
    settings = get_settings()

    from fastapi.testclient import TestClient
    from zhiku_api.main import create_app
    from zhiku_api.repositories import LibraryRepository
    from zhiku_api.services import DiagnosticsService, ImportService
    from zhiku_api.services.bilibili_service import BilibiliService, BilibiliVideo, TranscriptSegment

    sample_file = base_dir / 'sample.md'
    sample_file.write_text(
        '# 标题\n\n这是用于自测的知识内容，包含检索关键词：盘符医生。',
        encoding='utf-8',
    )

    app = create_app()
    client = TestClient(app)
    steps: list[dict[str, int | str]] = []
    static_probe_dir = knowledge_dir / 'static' / 'selftest'
    static_probe_dir.mkdir(parents=True, exist_ok=True)
    static_probe_file = static_probe_dir / 'ok.txt'
    static_probe_file.write_text('ok', encoding='utf-8')

    def check(name: str, method: str, url: str, **kwargs) -> dict | str:
        response = client.request(method, url, **kwargs)
        if response.status_code != 200:
            raise RuntimeError(f'{name} failed: {response.status_code} {response.text}')
        steps.append({'name': name, 'status': response.status_code})
        if response.headers.get('content-type', '').startswith('application/json'):
            return response.json()
        return response.text

    def run_bilinote_screenshot_marker_smoke() -> None:
        service = BilibiliService(settings=settings)
        source_url = 'https://www.bilibili.com/video/BV1SELFTEST1/?p=1'
        capture_state = {
            'label': '已建立时间化正文',
            'summary': 'selftest marker smoke',
            'recommended_action': None,
        }
        video = BilibiliVideo(
            bvid='BV1SELFTEST1',
            cid=1001,
            title='BiliNote Screenshot Smoke',
            author='selftest',
            description='',
            cover=None,
            duration=12,
            view=1,
            like=1,
            pubdate=None,
            tag_name=None,
        )
        transcript_segments = [
            TranscriptSegment(
                start_ms=1000,
                end_ms=3500,
                text='第一段展示重点界面与交互入口，适合作为关键画面示例。',
                source_kind='subtitle',
                quality_level='high',
            ),
            TranscriptSegment(
                start_ms=5000,
                end_ms=7600,
                text='第二段展示下一步操作和结果反馈，适合作为第二张关键画面。',
                source_kind='subtitle',
                quality_level='high',
            ),
        ]
        note_markdown = service._build_bilinote_markdown(
            video=video,
            source_url=source_url,
            summary='自测摘要',
            key_points=['第一段重点', '第二段重点'],
            content_text='用于验证截图 marker 替换链路。',
            transcript_segments=transcript_segments,
            transcript_source='subtitle',
            capture_state=capture_state,
            timestamps_available=True,
            timestamps_estimated=False,
            summary_focus='',
        )
        if 'Screenshot-[' not in note_markdown:
            raise RuntimeError('bilinote_screenshot_marker_smoke did not insert screenshot markers')

        stripped_markdown = service._strip_screenshot_markers_from_note_markdown(note_markdown)
        if 'Screenshot-[' in stripped_markdown:
            raise RuntimeError('bilinote_screenshot_marker_smoke did not strip screenshot markers')

        ffmpeg_binary = service._resolve_ffmpeg_binary()
        if not ffmpeg_binary:
            raise RuntimeError('bilinote_screenshot_marker_smoke missing ffmpeg binary')

        smoke_dir = base_dir / 'bilibili_screenshot_smoke'
        smoke_dir.mkdir(parents=True, exist_ok=True)
        smoke_video_path = smoke_dir / 'marker-smoke.mp4'
        render_result = subprocess.run(
            [
                ffmpeg_binary,
                '-loglevel',
                'error',
                '-y',
                '-f',
                'lavfi',
                '-i',
                'testsrc=size=640x360:rate=24:d=4',
                '-pix_fmt',
                'yuv420p',
                str(smoke_video_path),
            ],
            capture_output=True,
            text=True,
            timeout=45,
            check=False,
        )
        if render_result.returncode != 0 or not smoke_video_path.exists():
            stderr = (render_result.stderr or '').strip()
            raise RuntimeError(f'bilinote_screenshot_marker_smoke failed to create source video: {stderr}')

        candidates = service._build_note_screenshot_candidates(
            source_url=source_url,
            transcript_segments=transcript_segments,
            note_markdown=note_markdown,
        )
        if not candidates:
            raise RuntimeError('bilinote_screenshot_marker_smoke did not build screenshot candidates')
        if not all(candidate.get('marker') for candidate in candidates):
            raise RuntimeError('bilinote_screenshot_marker_smoke did not preserve marker metadata')

        screenshots = service._generate_note_screenshots(
            video=video,
            video_path=smoke_video_path,
            ffmpeg_binary=ffmpeg_binary,
            candidates=candidates,
        )
        if not screenshots:
            raise RuntimeError('bilinote_screenshot_marker_smoke did not generate screenshots')

        first_image_path = Path(str(screenshots[0].get('image_path') or ''))
        if not first_image_path.exists():
            raise RuntimeError('bilinote_screenshot_marker_smoke screenshot file missing on disk')

        injected_markdown = service._inject_screenshots_into_note_markdown(
            note_markdown,
            screenshots=screenshots,
        )
        if 'Screenshot-[' in injected_markdown:
            raise RuntimeError('bilinote_screenshot_marker_smoke left raw screenshot markers in markdown')
        if '![' not in injected_markdown:
            raise RuntimeError('bilinote_screenshot_marker_smoke did not inject image markdown')

        steps.append({'name': 'bilinote_screenshot_marker_smoke', 'status': 200})

    health = check('health', 'GET', '/api/v1/health')
    static_asset = check('static_asset', 'GET', '/static/selftest/ok.txt')
    if str(static_asset).strip() != 'ok':
        raise RuntimeError('static_asset did not return expected content')
    system_status = check('system_status', 'GET', '/api/v1/system/status')
    if 'asr' not in system_status:
        raise RuntimeError('system_status missing asr payload')
    if 'local_runtime_ready' not in system_status['asr']:
        raise RuntimeError('system_status missing asr local runtime payload')
    imported = check('import_file', 'POST', '/api/v1/imports/file', json={'file_path': str(sample_file)})
    if 'note_quality' not in ((imported.get('job', {}).get('preview', {}).get('metadata', {})) or {}):
        raise RuntimeError('import_file preview missing note_quality metadata')
    if 'content_terms' not in ((imported.get('job', {}).get('preview', {}).get('metadata', {})) or {}):
        raise RuntimeError('import_file preview missing content_terms metadata')
    content_id = imported['content']['id']
    job_id = imported['job']['id']
    uploaded = check(
        'import_file_upload',
        'POST',
        '/api/v1/imports/file-upload',
        json={
            'filename': 'upload-note.md',
            'content_base64': base64.b64encode(sample_file.read_bytes()).decode('ascii'),
        },
    )
    uploaded_content_id = uploaded['content']['id']

    check('get_import_job', 'GET', f'/api/v1/imports/{job_id}')
    contents = check('list_contents', 'GET', '/api/v1/contents')
    if contents['total'] < 1:
        raise RuntimeError('list_contents returned no records after import')

    check('get_content', 'GET', f'/api/v1/contents/{content_id}')
    check('get_uploaded_content', 'GET', f'/api/v1/contents/{uploaded_content_id}')
    updated = check(
        'update_content',
        'PATCH',
        f'/api/v1/contents/{content_id}',
        json={'title': '自测标题', 'tags': ['自测', '盘符医生']},
    )
    if updated['title'] != '自测标题':
        raise RuntimeError('update_content did not persist title')

    search = check('search_contents', 'GET', '/api/v1/contents', params={'q': '盘符医生'})
    if search['total'] < 1:
        raise RuntimeError('search_contents returned no matches')

    reparsed = check(
        'reparse_content',
        'POST',
        f'/api/v1/contents/{content_id}/reparse',
        json={'note_style': 'brief', 'summary_focus': '自测重解析'},
    )
    reparsed_metadata = (reparsed.get('content', {}).get('metadata', {})) or {}
    reparsed_versions = reparsed_metadata.get('note_versions') or []
    if not reparsed_versions:
        raise RuntimeError('reparse_content did not persist note_versions history')
    first_version = reparsed_versions[0]
    if first_version.get('note_style') != 'structured':
        raise RuntimeError('reparse_content note_versions missing previous note_style snapshot')
    if reparsed_metadata.get('note_style') != 'brief':
        raise RuntimeError('reparse_content did not apply requested note_style')
    restored_version = check(
        'restore_note_version',
        'POST',
        f'/api/v1/contents/{content_id}/restore-note-version',
        json={'version_id': first_version['id']},
    )
    restored_metadata = (restored_version.get('content', {}).get('metadata', {})) or {}
    if restored_metadata.get('note_style') != 'structured':
        raise RuntimeError('restore_note_version did not restore previous note_style')
    restored_versions = restored_metadata.get('note_versions') or []
    if not restored_versions:
        raise RuntimeError('restore_note_version did not preserve history after restoring')

    chat = check('chat_once', 'POST', '/api/v1/chat', json={'query': '盘符医生', 'limit': 3})
    if not chat['citations']:
        raise RuntimeError('chat_once returned no citations')
    repository = LibraryRepository(settings.db_path)
    import_service = ImportService(settings)
    timestamped_content = repository.create_content(
        content={
            'source_type': 'url',
            'platform': 'video_demo',
            'source_url': 'https://example.com/watch/demo',
            'source_file': None,
            'title': 'Timestamp demo',
            'author': None,
            'content_text': 'Boss spawn at 12 seconds. Use shield before burst.',
            'summary': 'Timestamp demo summary',
            'key_points': ['Boss spawn at 12 seconds'],
            'quotes': [],
            'category': 'selftest',
            'content_type': 'video',
            'use_case': 'test',
            'tags': ['selftest', 'timestamp'],
            'metadata': {
                'transcript_segments': [
                    {
                        'start_ms': 12000,
                        'end_ms': 16000,
                        'text': 'Boss spawn at 12 seconds. Use shield before burst.',
                        'source_kind': 'subtitle',
                        'quality_level': 'high',
                        'timestamp_label': '00:12 - 00:16',
                        'seek_url': 'https://example.com/watch/demo?t=12',
                    }
                ],
                'transcript_source': 'subtitle',
                'timestamps_available': True,
                'timestamps_estimated': False,
                'capture_status': 'ready',
                'capture_summary': 'selftest ready',
                'note_markdown': '# 精炼笔记\n\n- 12 秒会出现 Boss\n- 爆发前先开护盾',
                'refined_note_markdown': '# 精炼笔记\n\n- 12 秒会出现 Boss\n- 爆发前先开护盾',
            },
            'local_path': None,
            'status': 'ready',
        }
    )
    timestamped_detail = repository.get_content(timestamped_content['id'])
    if not timestamped_detail or (
        timestamped_detail['chunks'][0]['metadata'].get('seek_url') != 'https://example.com/watch/demo?t=12'
    ):
        raise RuntimeError('timestamped content chunk missing seek_url metadata')
    seek_chat = check(
        'chat_timestamp_seek',
        'POST',
        '/api/v1/chat',
        json={'query': 'shield', 'content_id': timestamped_content['id'], 'limit': 3},
    )
    first_seek_citation = (seek_chat.get('citations') or [{}])[0]
    if first_seek_citation.get('seek_url') != 'https://example.com/watch/demo?t=12':
        raise RuntimeError('chat_timestamp_seek returned citation without seek_url')
    scoped_summary_chat = check(
        'chat_scoped_note_layer',
        'POST',
        '/api/v1/chat',
        json={'query': '请先概括这条视频最值得记住的两个结论', 'content_id': timestamped_content['id'], 'limit': 3},
    )
    if scoped_summary_chat.get('quality', {}).get('degraded'):
        raise RuntimeError('chat_scoped_note_layer unexpectedly degraded for scoped note query')
    if not scoped_summary_chat.get('citations'):
        raise RuntimeError('chat_scoped_note_layer returned no citations')
    if not any((item or {}).get('heading') == '精炼笔记' for item in scoped_summary_chat.get('citations') or []):
        raise RuntimeError('chat_scoped_note_layer did not prioritize note layer citation')
    scoped_summary_answer = str(scoped_summary_chat.get('answer') or '')
    if '当前已经找到' in scoped_summary_answer or '优先可参考的内容' in scoped_summary_answer:
        raise RuntimeError('chat_scoped_note_layer still returned rigid retrieval template')

    legacy_content = repository.create_content(
        content={
            'source_type': 'url',
            'platform': 'legacy_demo',
            'source_url': 'https://example.com/watch/legacy',
            'source_file': None,
            'title': 'Legacy upgrade demo',
            'author': None,
            'content_text': 'Legacy transcript for upgrade validation.',
            'summary': 'Legacy upgrade summary',
            'key_points': ['Legacy transcript for upgrade validation.'],
            'quotes': [],
            'category': 'selftest',
            'content_type': 'video',
            'use_case': 'test',
            'tags': ['legacy', 'upgrade'],
            'metadata': {
                'transcript_segments': [
                    {
                        'start_ms': 5000,
                        'end_ms': 9000,
                        'text': 'Legacy transcript for upgrade validation.',
                        'source_kind': 'subtitle',
                        'quality_level': 'high',
                    }
                ],
                'transcript_source': 'subtitle',
                'timestamps_available': True,
                'timestamps_estimated': False,
                'note_markdown': '# Legacy\n\n- upgrade check',
                'refined_note_markdown': '# Legacy\n\n- upgrade check',
                'import_mode': 'parsed',
                'note_style': 'structured',
                'summary_focus': '',
            },
            'local_path': None,
            'status': 'ready',
        }
    )
    upgraded = check(
        'upgrade_contents',
        'POST',
        '/api/v1/contents/maintenance/upgrade',
        json={'platform': 'legacy_demo', 'limit': 10},
    )
    if upgraded.get('summary', {}).get('upgraded', 0) < 1:
        raise RuntimeError('upgrade_contents did not upgrade legacy content')
    legacy_detail = repository.get_content(legacy_content['id'])
    if not legacy_detail:
        raise RuntimeError('legacy content missing after upgrade_contents')
    legacy_metadata = legacy_detail.get('metadata', {})
    if 'note_quality' not in legacy_metadata:
        raise RuntimeError('upgrade_contents did not attach note_quality')
    if 'content_terms' not in legacy_metadata:
        raise RuntimeError('upgrade_contents did not attach content_terms')
    upgraded_segments = legacy_metadata.get('transcript_segments') or []
    if not upgraded_segments or upgraded_segments[0].get('seek_url') != 'https://example.com/watch/legacy?t=5':
        raise RuntimeError('upgrade_contents did not backfill transcript seek_url')

    ready_rank_payload = import_service.upgrade_existing_content(
        {
            'source_type': 'url',
            'platform': 'video_rank_demo',
            'source_url': 'https://example.com/watch/rank-ready',
            'source_file': None,
            'title': 'Ready rank demo',
            'author': None,
            'content_text': 'quality rank token appears in a stable ready transcript',
            'summary': 'quality rank token ready summary',
            'key_points': ['quality rank token ready evidence'],
            'quotes': [],
            'category': 'selftest',
            'content_type': 'video',
            'use_case': 'test',
            'tags': ['rank', 'ready'],
            'metadata': {
                'transcript_segments': [
                    {
                        'start_ms': 1000,
                        'end_ms': 4000,
                        'text': 'quality rank token appears in a stable ready transcript',
                        'source_kind': 'subtitle',
                        'quality_level': 'high',
                    }
                ],
                'transcript_source': 'subtitle',
                'timestamps_available': True,
                'timestamps_estimated': False,
                'capture_status': 'ready',
                'capture_summary': 'ready rank content',
                'note_markdown': '# Ready rank\n\n- quality rank token',
                'refined_note_markdown': '# Ready rank\n\n- quality rank token',
                'note_style': 'structured',
            },
            'local_path': None,
            'status': 'ready',
        }
    )
    blocked_rank_payload = import_service.upgrade_existing_content(
        {
            'source_type': 'url',
            'platform': 'video_rank_demo',
            'source_url': 'https://example.com/watch/rank-blocked',
            'source_file': None,
            'title': 'Blocked rank demo',
            'author': None,
            'content_text': 'quality rank token appears in a blocked fallback transcript',
            'summary': 'quality rank token blocked summary',
            'key_points': ['quality rank token blocked evidence'],
            'quotes': [],
            'category': 'selftest',
            'content_type': 'video',
            'use_case': 'test',
            'tags': ['rank', 'blocked'],
            'metadata': {
                'transcript_segments': [
                    {
                        'text': 'quality rank token appears in a blocked fallback transcript',
                        'source_kind': 'description',
                        'quality_level': 'fallback',
                    }
                ],
                'transcript_source': 'description',
                'timestamps_available': False,
                'timestamps_estimated': False,
                'capture_status': 'needs_asr',
                'capture_summary': 'blocked rank content',
                'capture_recommended_action': 'configure asr',
                'note_markdown': '# Blocked rank\n\n- quality rank token',
                'refined_note_markdown': '# Blocked rank\n\n- quality rank token',
                'note_style': 'structured',
            },
            'local_path': None,
            'status': 'needs_asr',
        }
    )
    repository.create_content(content=blocked_rank_payload)
    repository.create_content(content=ready_rank_payload)
    rank_chat = check('chat_quality_rank', 'POST', '/api/v1/chat', json={'query': 'quality rank token', 'limit': 4})
    citations = rank_chat.get('citations') or []
    ready_citation = next((item for item in citations if item.get('title') == 'Ready rank demo'), None)
    blocked_citation = next((item for item in citations if item.get('title') == 'Blocked rank demo'), None)
    if not ready_citation or not blocked_citation:
        raise RuntimeError('chat_quality_rank did not return both rank test citations')
    if float(ready_citation.get('score', 0)) <= float(blocked_citation.get('score', 0)):
        raise RuntimeError('chat_quality_rank did not prefer ready content over blocked content')

    run_bilinote_screenshot_marker_smoke()

    stream = client.post('/api/v1/chat/stream', json={'query': '盘符医生', 'limit': 3})
    if stream.status_code != 200 or 'event: done' not in stream.text:
        raise RuntimeError(f'stream_chat failed: {stream.status_code} {stream.text}')
    steps.append({'name': 'stream_chat', 'status': stream.status_code})

    markdown = check('export_markdown', 'POST', f'/api/v1/contents/{content_id}/export-markdown')
    if not Path(markdown['path']).exists():
        raise RuntimeError('export_markdown output file missing')

    summary = check('diagnostics_summary', 'GET', '/api/v1/diagnostics/summary')
    if not summary['paths']['app_data_dir']:
        raise RuntimeError('diagnostics_summary missing app_data_dir')

    original_probe_bilibili_url = DiagnosticsService.probe_bilibili_url

    def fake_probe_bilibili_url(self, raw_url: str) -> dict:
        return {
            'platform': 'bilibili',
            'source_url': raw_url,
            'source_url_original': raw_url,
            'title': '自测 B站预检',
            'author': 'selftest',
            'parse_mode': 'api',
            'bvid': 'BV1SELFTEST1',
            'cid': 1001,
            'page_number': 1,
            'duration': 120,
            'cover': None,
            'subtitle_count': 0,
            'subtitle_available': False,
            'subtitle_login_required': True,
            'subtitle_preview_toast': None,
            'subtitle_error': None,
            'audio_available': True,
            'audio_error': None,
            'cookie_configured': False,
            'cookie_source': 'none',
            'asr_configured': False,
            'asr_selected': False,
            'asr_provider': '',
            'asr_model': '',
            'asr_local_runtime_ready': False,
            'asr_local_engine': '',
            'asr_runtime_summary': 'selftest',
            'timestamps_available': False,
            'predicted_status': 'needs_cookie',
            'predicted_quality': 'subtitle_requires_login',
            'predicted_summary': '自测：当前缺少登录态。',
            'predicted_recommended_action': '自测：请先补 Cookie。',
        }

    DiagnosticsService.probe_bilibili_url = fake_probe_bilibili_url
    try:
        probe = check(
            'diagnostics_bilibili_probe',
            'POST',
            '/api/v1/diagnostics/bilibili-probe',
            json={'url': 'https://www.bilibili.com/video/BV1SELFTEST1/'},
        )
    finally:
        DiagnosticsService.probe_bilibili_url = original_probe_bilibili_url

    if probe['probe']['predicted_status'] != 'needs_cookie':
        raise RuntimeError('diagnostics_bilibili_probe returned unexpected status')

    diagnostics = check('diagnostics_export', 'POST', '/api/v1/diagnostics/export')
    if not Path(diagnostics['path']).exists():
        raise RuntimeError('diagnostics_export output archive missing')

    backup = check('create_backup', 'POST', '/api/v1/backups')
    if not Path(backup['archive_path']).exists():
        raise RuntimeError('create_backup output archive missing')

    deleted = check('delete_content', 'DELETE', f'/api/v1/contents/{content_id}')
    if deleted['deleted'] is not True:
        raise RuntimeError('delete_content did not mark item deleted')

    trash = check('trash_list', 'GET', '/api/v1/contents/trash/list')
    if trash['total'] < 1:
        raise RuntimeError('trash_list returned no deleted items')

    restored = check('restore_content', 'POST', f'/api/v1/contents/{content_id}/restore')
    if restored['restored'] is not True:
        raise RuntimeError('restore_content did not restore item')

    return {
        'ok': True,
        'health': health,
        'content_id': content_id,
        'artifacts_dir': str(base_dir),
        'steps': steps,
    }


def main() -> int:
    try:
        result = run()
    except Exception as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}, ensure_ascii=False, indent=2), file=sys.stderr)
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
