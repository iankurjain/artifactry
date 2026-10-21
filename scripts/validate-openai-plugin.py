#!/usr/bin/env python3
"""Check an OpenAI plugin directory ZIP against the published submission rules.

Rules come from developers.openai.com/plugins (deploy/submission,
deploy/submission-errors, plugin-guidelines, deploy/app-review), read
2026-10-21. Covers the ZIP layout, manifest and listing limits, review test
cases, skills and icons. It cannot check what the portal checks live: the
domain challenge, the tool scan, verified identity or reviewer login.

Usage: validate-openai-plugin.py <plugin.zip>   (exit 1 on any error)
"""
import io
import json
import re
import sys
import unicodedata
import zipfile

from PIL import Image

errors, warnings = [], []


def err(code, msg):
    errors.append(f'{code}: {msg}')


def warn(code, msg):
    warnings.append(f'{code}: {msg}')


BAD_CHARS = re.compile('[\x00-\x08\x0b-\x1f\x7f  ​-‏‪-‮⁠-⁤﻿]')
SEMVER = re.compile(r'^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$')
HEX = re.compile(r'^#[0-9A-Fa-f]{6}$')
CATEGORIES = {
    'Productivity', 'Creativity', 'Developer Tools', 'Business & Operations', 'Data & Analytics',
    'Communication', 'Education & Research', 'Security', 'Finance', 'Healthcare', 'Travel',
    'Entertainment', 'Other',
}
# Guideline wording: no "MCP"/"Plugin" in names, no pricing, no comparisons.
BANNED_NAME = re.compile(r'\b(mcp|plugin)\b', re.I)
PRICING = re.compile(r'\b(free|pricing|price|subscription|trial|discount|promo|beta|cheap|\$\d)', re.I)
COMPARE = re.compile(r'\b(better than|best|unlike|#1|number one|vs\.?|versus)\b', re.I)


def text(field, value, limit, one_line=True, required=True):
    if value is None:
        if required:
            err(f'{field}_required', 'missing')
        return
    if not isinstance(value, str) or not value.strip():
        err(f'{field}_empty', 'must be a non-empty string')
        return
    if one_line and ('\n' in value or '\r' in value):
        err(f'{field}_character_unsupported', 'must be one line')
    if BAD_CHARS.search(value.replace('\n', '')):
        err(f'{field}_character_unsupported', 'control or invisible characters')
    if len(value) > limit:
        err(f'{field}_too_long', f'{len(value)} > {limit}')


def https(field, value, limit=1024, required=True):
    if value is None:
        if required:
            err(f'{field}_required', 'missing (required for remote MCP submissions)')
        return
    if not isinstance(value, str) or not re.match(r'^https://[^/@\s]+', value):
        err(f'{field}_format', f'must be https with a host and no credentials: {value!r}')
    elif len(value) > limit:
        err(f'{field}_too_long', f'{len(value)} > {limit}')


def luminance(hex_color):
    def chan(c):
        c = c / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (int(hex_color[i:i + 2], 16) for i in (1, 3, 5))
    return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b)


def contrast(a, b):
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def main(path):
    try:
        zf = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        err('archive_format_not_zip', path)
        return
    infos = zf.infolist()
    if not infos:
        err('archive_empty', path)
        return
    if len(infos) > 5000:
        err('archive_too_many_entries', str(len(infos)))
    total = 0
    seen = set()
    for i in infos:
        n = i.filename
        total += i.file_size
        if n != n.strip():
            err('archive_member_path_has_outer_whitespace', n)
        if '\\' in n:
            err('archive_member_path_has_backslash', n)
        if n.startswith('/') or re.match(r'^[A-Za-z]:', n):
            err('archive_member_path_absolute', n)
        segs = n.rstrip('/').split('/')
        if '' in segs:
            err('archive_member_path_has_empty_segment', n)
        if '..' in segs:
            err('archive_member_path_has_parent_segment', n)
        if len(segs) > 20:
            err('archive_member_path_too_deep', n)
        key = unicodedata.normalize('NFC', n).lower()
        if key in seen:
            err('archive_member_path_normalization_collision', n)
        seen.add(key)
        if i.file_size > 100 * 1024 * 1024:
            err('archive_member_too_large', n)
        if i.flag_bits & 0x1:
            err('archive_member_unreadable', f'{n} is encrypted')
        mode = (i.external_attr >> 16) & 0o170000
        if mode and mode not in (0o100000, 0o040000):
            err('archive_member_type_unsupported', n)
        if re.search(r'(^|/)(\.env|.*\.pem|.*\.key|id_rsa)$', n):
            err('secret_in_zip', n)
    if total > 512 * 1024 * 1024:
        err('archive_uncompressed_too_large', str(total))

    names = {i.filename for i in infos if not i.is_dir()}

    def read(p):
        return zf.read(p)

    def exists(rel):
        return rel in names

    # Plugin root must be the archive root (we never nest it).
    if any(n.startswith('__MACOSX') or n.endswith('.DS_Store') for n in names):
        err('plugin_root_has_siblings', 'macOS metadata in archive')

    if 'plugin.json' in names:
        layout = 'portable'
        manifest = json.loads(read('plugin.json'))
        if manifest.get('$schema') != 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json':
            err('plugin_manifest_missing', 'root plugin.json needs the Agent Plugins $schema')
        ext = manifest.get('extensions', {}).get('com.openai', {})
        iface = ext.get('interface')
        mcp_path = 'mcp.json'
        if '.codex-plugin/plugin.json' in names:
            warn('manifest_overlay_ignored', 'extensions.com.openai.interface replaces .codex-plugin overlay')
    elif '.codex-plugin/plugin.json' in names:
        layout = 'codex'
        manifest = json.loads(read('.codex-plugin/plugin.json'))
        ext = manifest.get('extensions', {}).get('com.openai', {})
        iface = manifest.get('interface')
        if manifest.get('skills') != './skills/':
            err('plugin_skills_path_unsupported', 'skills must be "./skills/"')
        if manifest.get('mcpServers') != './.mcp.json':
            err('plugin_mcp_path_unsupported', 'mcpServers must be "./.mcp.json"')
        mcp_path = '.mcp.json'
    else:
        err('plugin_manifest_missing', 'no plugin.json or .codex-plugin/plugin.json at the archive root')
        return
    print(f'layout: {layout}')

    if not isinstance(manifest, dict):
        err('plugin_manifest_root_not_object', '')
        return

    # Package identity
    name = manifest.get('name')
    if not isinstance(name, str) or not name:
        err('plugin_name_missing', '')
    else:
        if len(name) > 64:
            err('plugin_name_too_long', name)
        if not re.match(r'^[a-z0-9]+(-[a-z0-9]+)*$', name):
            err('plugin_name_format', f'{name!r} (lowercase, digits, single hyphens)')
    v = manifest.get('version')
    if not isinstance(v, str) or not SEMVER.match(v) or len(v) > 64:
        err('plugin_version_not_semver', repr(v))
    text('plugin_description', manifest.get('description'), 1024, one_line=False)
    author = manifest.get('author')
    if not isinstance(author, dict):
        err('plugin_developer_missing', 'author must be an object with name')
    else:
        text('plugin_author_name', author.get('name'), 120)
        if 'email' in author:
            text('plugin_author_email', author['email'], 320)
        if 'url' in author:
            https('plugin_author_url', author['url'], 2048)
    if 'homepage' in manifest:
        https('plugin_homepage', manifest['homepage'], 2048)
    if 'apps' in manifest or 'apps' in ext or '.app.json' in names:
        err('app_configuration_excluded', 'apps / .app.json cannot be submitted')
    if 'hooks' in ext or 'hooks' in manifest or any(n.startswith('hooks/') for n in names):
        err('lifecycle_hooks_excluded', 'hooks make a plugin ineligible for the public directory')

    # Listing (final submission limits)
    if not isinstance(iface, dict):
        err('plugin_interface_wrong_type', 'interface missing')
        iface = {}
    text('submission_display_name', iface.get('displayName'), 30)
    text('submission_subtitle', iface.get('shortDescription'), 30)
    text('submission_description', iface.get('longDescription'), 4000, one_line=False)
    text('submission_developer_name', iface.get('developerName'), 80)
    if iface.get('category') not in CATEGORIES:
        err('plugin_category_unknown', repr(iface.get('category')))
    caps = iface.get('capabilities', [])
    if not isinstance(caps, list) or len(caps) > 20:
        err('plugin_capabilities_too_many', 'list of at most 20')
    for c in caps if isinstance(caps, list) else []:
        text('plugin_capability', c, 120)
    for f in ('websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL'):
        https(f'plugin_{f}', iface.get(f))
    prompts = iface.get('defaultPrompt', [])
    if isinstance(prompts, str):
        prompts = [prompts]
    if len(prompts) > 3:
        err('plugin_default_prompt_too_many', str(len(prompts)))
    norm = set()
    for p in prompts:
        text('plugin_default_prompt', p, 128)
        if isinstance(p, str):
            if '@' in p:
                err('plugin_default_prompt_mention', p)
            k = ' '.join(unicodedata.normalize('NFKC', p).split()).lower()
            if k in norm:
                err('plugin_default_prompt_duplicate', p)
            norm.add(k)
    if 'brandColor' in iface:
        if not HEX.match(iface['brandColor']):
            err('plugin_brand_color_format', iface['brandColor'])
        elif contrast(iface['brandColor'], '#FFFFFF') < 2:
            err('plugin_brand_color_contrast', f"{contrast(iface['brandColor'], '#FFFFFF'):.2f}:1 vs white")
    if 'brandColorDark' in iface:
        if not HEX.match(iface['brandColorDark']):
            err('plugin_brand_color_dark_format', iface['brandColorDark'])
        elif contrast(iface['brandColorDark'], '#212121') < 2:
            err('plugin_brand_color_dark_contrast', f"{contrast(iface['brandColorDark'], '#212121'):.2f}:1 vs #212121")
    if iface.get('screenshots'):
        err('screenshots_not_allowed', 'the server has no UI output template, so screenshots are rejected')

    # Guideline wording checks on everything shown in the listing
    for f in ('displayName', 'shortDescription'):
        if isinstance(iface.get(f), str) and BANNED_NAME.search(iface[f]):
            err('guideline_name', f'{f} must not say MCP or Plugin')
    listing = ' '.join(str(iface.get(f, '')) for f in ('shortDescription', 'longDescription')) + ' ' + ' '.join(caps)
    for rx, code in ((PRICING, 'guideline_pricing'), (COMPARE, 'guideline_comparison')):
        m = rx.search(listing)
        if m:
            err(code, f'listing text mentions {m.group(0)!r}')

    # Icons
    def image(field, required):
        rel = iface.get(field)
        if rel is None:
            if required:
                err(f'{field}_required', 'missing')
            return
        if not isinstance(rel, str) or not rel.startswith('./') or '..' in rel.split('/'):
            err('asset_path_invalid', f'{field}: {rel!r}')
            return
        p = rel[2:]
        if not exists(p):
            err('asset_missing', f'{field}: {rel}')
            return
        data = read(p)
        if len(data) > 5 * 1024 * 1024:
            err('image_too_large', p)
        ext_ = p.rsplit('.', 1)[-1].lower()
        if ext_ not in ('png', 'jpg', 'jpeg', 'webp', 'svg'):
            err('image_extension', p)
            return
        if ext_ == 'svg':
            if b'<svg' not in data:
                err('image_svg_invalid', p)
            return
        im = Image.open(io.BytesIO(data))
        fmt = {'png': 'PNG', 'jpg': 'JPEG', 'jpeg': 'JPEG', 'webp': 'WEBP'}[ext_]
        if im.format != fmt:
            err('image_format_mismatch', f'{p} is {im.format}')
        w, h = im.size
        if w != h or w < 48 or w > 4096:
            err('image_dimensions', f'{p} is {w}x{h} (square, 48..4096)')

    image('logo', True)
    image('composerIcon', True)
    image('logoDark', False)
    image('composerIconDark', False)

    # Skills
    skill_dirs = sorted({n.split('/')[1] for n in names if n.startswith('skills/') and n.count('/') >= 2})
    if not skill_dirs:
        err('plugin_runtime_surface_missing', 'no skills/')
    skill_names = set()
    for d in skill_dirs:
        if d.startswith('.'):
            err('skill_directory_hidden', d)
        p = f'skills/{d}/SKILL.md'
        if p not in names:
            err('skill_md_missing', p)
            continue
        body = read(p).decode('utf-8')
        m = re.match(r'^---\n(.*?)\n---\n(.*)$', body, re.S)
        if not m:
            err('skill_front_matter_invalid', p)
            continue
        fm = dict(re.findall(r'^(\w+):\s*(.*)$', m.group(1), re.M))
        sname, sdesc = fm.get('name', '').strip(), fm.get('description', '').strip()
        if not sname:
            err('skill_name_missing', p)
        if not sdesc or len(sdesc) > 1024:
            err('skill_description_invalid', p)
        if not m.group(2).strip():
            err('skill_instructions_empty', p)
        if name and len(f'{name}:{sname}') > 64:
            err('skill_qualified_name_too_long', f'{name}:{sname}')
        if sname in skill_names:
            err('skill_name_duplicate', sname)
        skill_names.add(sname)
    onboarding = ext.get('onboardingSkill')
    if onboarding and onboarding[2:] not in names:
        err('onboarding_skill_missing', onboarding)

    # MCP configuration: exactly one remote HTTPS server, OAuth, no secrets or headers
    if mcp_path not in names:
        err('plugin_mcp_file_missing', mcp_path)
    else:
        mcp = json.loads(read(mcp_path))
        servers = mcp.get('mcpServers')
        if not isinstance(servers, dict) or len(servers) != 1:
            err('mcp_servers_count', 'exactly one MCP server per plugin')
        else:
            (sname, s), = servers.items()
            https('mcp_server_url', s.get('url'), 2048)
            if s.get('headers'):
                err('mcp_server_headers_not_allowed', 'public submission rejects nonempty headers')
            if 'clientSecret' in json.dumps(mcp):
                err('mcp_client_secret_not_allowed', 'clientSecret in mcp.json')
            if layout == 'portable':
                if mcp.get('$schema') != 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json':
                    err('mcp_manifest_schema', 'portable mcp.json needs the Agent Plugins $schema')
                if s.get('type') != 'streamable-http':
                    err('mcp_server_type', 'remote servers use type "streamable-http"')
                auth = s.get('extensions', {}).get('com.openai', {}).get('auth', {})
                if auth.get('type') not in ('oauth', 'none'):
                    err('mcp_auth_type', 'the portal supports only none or oauth')

    # Review block
    review = ext.get('review', {})
    for bad in ('test_credentials', 'reviewer_instructions'):
        if bad in json.dumps(review):
            err('review_secret_field', bad)
    tc = review.get('test_cases', {})
    pos, neg = tc.get('positive', []), tc.get('negative', [])
    if len(pos) != 5:
        err('positive_test_cases', f'exactly 5 required, found {len(pos)}')
    if len(neg) != 3:
        err('negative_test_cases', f'exactly 3 required, found {len(neg)}')
    for i, c in enumerate(pos):
        for f in ('description', 'prompt', 'tools_triggered', 'expected_behavior'):
            text(f'positive[{i}].{f}', c.get(f), 4000, one_line=False)
    for i, c in enumerate(neg):
        for f in ('description', 'prompt'):
            text(f'negative[{i}].{f}', c.get(f), 4000, one_line=False)
    if not review.get('demo_recording_url'):
        warn('demo_recording_url', 'not in the ZIP: enter it in the portal before Submit for review')
    else:
        https('demo_recording_url', review['demo_recording_url'], 2048)
    if review.get('commerce') is not False:
        warn('commerce', 'commerce should be false for Artifactry')
    pub = ext.get('publication', {})
    if not pub.get('release_notes'):
        err('release_notes_required', 'missing')

    # Whole-package secret sweep
    for n in names:
        if n.endswith(('.json', '.md', '.txt', '.yaml', '.yml')):
            t = read(n).decode('utf-8', 'replace')
            if re.search(r'(sk-[A-Za-z0-9]{20,}|art_pat_[A-Za-z0-9]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY)', t):
                err('secret_in_zip', n)


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
    for w in warnings:
        print('warning', w)
    for e in errors:
        print('ERROR', e)
    print(f'{len(errors)} errors, {len(warnings)} warnings')
    sys.exit(1 if errors else 0)
