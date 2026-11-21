#!/usr/bin/env python3
"""Add or update the "Lurkbox" non-Steam shortcut in a binary shortcuts.vdf, and print its appid.

Runs on the Steam Machine (piped over SSH by deploy-steammachine.sh); standard library only.
  python3 - <shortcuts.vdf> <exe> <icon> [launch options]   -> prints the unsigned 32-bit appid
The appid is computed the way Steam does for non-Steam shortcuts (crc32(exe + name) | 0x80000000) and is also
written into the entry so it stays stable. Grid artwork uses that unsigned appid in its file names.
"""
import os, struct, sys, zlib

NAME = 'Lurkbox'

def parse(b, i):
    d = {}
    while True:
        t = b[i]; i += 1
        if t == 8:
            return d, i
        j = b.index(0, i); k = b[i:j].decode('utf-8', 'surrogateescape'); i = j + 1
        if t == 0:
            d[k], i = parse(b, i)
        elif t == 1:
            j = b.index(0, i); d[k] = b[i:j].decode('utf-8', 'surrogateescape'); i = j + 1
        elif t == 2:
            d[k] = struct.unpack('<i', b[i:i + 4])[0]; i += 4
        elif t == 7:
            d[k] = ('u64', struct.unpack('<Q', b[i:i + 8])[0]); i += 8
        else:
            raise ValueError(f'unknown vdf type {t} at {i}')

def dump(d):
    out = b''
    for k, v in d.items():
        kb = k.encode('utf-8', 'surrogateescape') + b'\0'
        if isinstance(v, dict):
            out += b'\0' + kb + dump(v) + b'\x08'
        elif isinstance(v, tuple) and v[0] == 'u64':
            out += b'\7' + kb + struct.pack('<Q', v[1])
        elif isinstance(v, int):
            out += b'\2' + kb + struct.pack('<i', v)
        else:
            out += b'\1' + kb + v.encode('utf-8', 'surrogateescape') + b'\0'
    return out

def appid_for(exe, name=NAME):
    return zlib.crc32((exe + name).encode()) | 0x80000000

def name_of(e):
    return e.get('appname', e.get('AppName'))

def upsert(root, exe, icon, launch=''):
    sc = root.setdefault('shortcuts', {})
    qexe = f'"{exe}"'
    uid = appid_for(qexe)
    entry = next((e for e in sc.values() if name_of(e) == NAME), None)
    if entry is None:
        entry = {}
        sc[str(max((int(k) for k in sc), default=-1) + 1)] = entry
    entry.update({
        'appid': struct.unpack('<i', struct.pack('<I', uid))[0],
        'AppName': NAME,
        'Exe': qexe,
        'StartDir': f'"{os.path.dirname(exe)}/"',
        'icon': icon,
        'ShortcutPath': '',
        'LaunchOptions': launch,
        'IsHidden': 0,
        'AllowDesktopConfig': 1,
        'AllowOverlay': 1,
        'OpenVR': 0,
        'Devkit': 0,
        'DevkitGameID': '',
        'DevkitOverrideAppID': 0,
    })
    # Steam writes some keys in a different case (e.g. "exe", "appname"); drop those so there are no duplicates.
    canon = {k.lower(): k for k in ('appid', 'AppName', 'Exe', 'StartDir', 'icon', 'ShortcutPath', 'LaunchOptions',
                                     'IsHidden', 'AllowDesktopConfig', 'AllowOverlay', 'OpenVR', 'Devkit', 'DevkitGameID',
                                     'DevkitOverrideAppID')}
    for k in [k for k in entry if k.lower() in canon and k != canon[k.lower()]]:
        del entry[k]
    entry.setdefault('LastPlayTime', 0)
    entry.setdefault('FlatpakAppID', '')
    entry.setdefault('tags', {})
    return uid

def main(argv):
    if argv[1] == '--appid':  # just print the appid; never touches the file
        print(appid_for(f'"{argv[2]}"'))
        return
    path, exe, icon = argv[1], argv[2], argv[3]
    launch = argv[4] if len(argv) > 4 else ''
    root = parse(open(path, 'rb').read(), 0)[0] if os.path.exists(path) else {'shortcuts': {}}
    uid = upsert(root, exe, icon, launch)
    data = dump(root) + b'\x08'
    check = parse(data, 0)[0]
    assert any(name_of(e) == NAME for e in check['shortcuts'].values()), 'round-trip lost the entry'
    tmp = path + '.lurkbox-tmp'
    open(tmp, 'wb').write(data)
    os.replace(tmp, path)
    print(uid)

if __name__ == '__main__':
    main(sys.argv)
