#!/usr/bin/env python3
"""Migrates bridge files from v1.3 (extend) to v1.4 (tool...from) syntax."""

import re
import os

def migrate_file(filepath):
    with open(filepath, 'r') as f:
        content = f.read()
    
    original = content
    
    # 1. Replace `version 1.3` with `version 1.4`
    content = content.replace('version 1.3', 'version 1.4')
    
    # 2. Replace `extend <source> as <name>` with `tool <name> from <source>`
    def replace_extend(m):
        prefix = m.group(1)
        source = m.group(2)
        name = m.group(3)
        suffix = m.group(4) or ''
        return f"{prefix}tool {name} from {source}{suffix}"
    
    content = re.sub(
        r'^(\s*)[Ee]xtend\s+(\S+)\s+as\s+(\S+)(\s*\{)?',
        replace_extend,
        content,
        flags=re.MULTILINE
    )
    
    # 3. Fix quoted strings in assertions: "extend X as Y" -> "tool Y from X"
    def replace_extend_in_string(m):
        quote = m.group(1)
        source = m.group(2)
        name = m.group(3)
        rest = m.group(4)
        return f'{quote}tool {name} from {source}{rest}'
    
    content = re.sub(
        r'(["\'])[Ee]xtend\s+(\S+)\s+as\s+(\S+)(.*?["\'])',
        replace_extend_in_string,
        content
    )
    
    if content != original:
        with open(filepath, 'w') as f:
            f.write(content)
        return True
    return False

files = [
    'test/bridge-format.test.ts',
    'test/tool-features.test.ts',
    'test/resilience.test.ts',
    'test/scheduling.test.ts',
    'test/builtin-tools.test.ts',
    'test/force-wire.test.ts',
    'test/chained.test.ts',
    'test/email.test.ts',
    'test/executeGraph.test.ts',
    'test/property-search.bridge',
    'test/http-executor.test.ts',
    'examples/weather-api/Weather.bridge',
    'examples/builtin-tools/builtin-tools.bridge',
]

for f in files:
    if os.path.exists(f):
        changed = migrate_file(f)
        if changed:
            print(f"  migrated: {f}")
        else:
            print(f"  no change: {f}")
    else:
        print(f"  NOT FOUND: {f}")
