"""Run after `npx cap add android`: adds camera permission, icons and version numbers.
Usage: python3 native-patch.py <repo-root> <android-dir> [versionCode] [versionName]"""
import os, re, sys
from PIL import Image

root, android = sys.argv[1], sys.argv[2]
version_code = sys.argv[3] if len(sys.argv) > 3 else '1'
version_name = sys.argv[4] if len(sys.argv) > 4 else '1.0.0'

# --- Manifest: camera for the barcode scanner
mf = os.path.join(android, 'app/src/main/AndroidManifest.xml')
s = open(mf).read()
add = ''
for perm in ['android.permission.CAMERA', 'android.permission.ACCESS_NETWORK_STATE', 'android.permission.VIBRATE', 'android.permission.POST_NOTIFICATIONS']:
    if perm not in s:
        add += f'    <uses-permission android:name="{perm}" />\n'
if 'android.hardware.camera' not in s:
    add += '    <uses-feature android:name="android.hardware.camera" android:required="false" />\n'
# Android 11+ hides other apps from this one unless listed here. Without it the phone's own camera app cannot be started to take a photo.
if 'android.media.action.IMAGE_CAPTURE' not in s:
    add += '    <queries>\n        <intent>\n            <action android:name="android.media.action.IMAGE_CAPTURE" />\n        </intent>\n    </queries>\n'
s = s.replace('</manifest>', add + '</manifest>')
# RevenueCat's purchase screen needs the main screen to start as singleTop (or standard), not singleTask.
s = s.replace('android:launchMode="singleTask"', 'android:launchMode="singleTop"')
open(mf, 'w').write(s)

# --- Version numbers
gr = os.path.join(android, 'app/build.gradle')
g = open(gr).read()
g = re.sub(r'versionCode\s+\d+', f'versionCode {version_code}', g)
g = re.sub(r'versionName\s+"[^"]*"', f'versionName "{version_name}"', g)
open(gr, 'w').write(g)

# --- Icons: mascot on a soft teal background (placeholder until final store art)
mascot = Image.open(os.path.join(root, 'splash-mascot.png')).convert('RGBA')
BG = (207, 243, 240, 255)
res = os.path.join(android, 'app/src/main/res')
legacy = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
fore = {'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432}

def compose(size, frac):
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    m = mascot.resize((int(size * frac), int(size * frac)), Image.LANCZOS)
    canvas.alpha_composite(m, ((size - m.width) // 2, (size - m.height) // 2))
    return canvas

for d, px in legacy.items():
    folder = os.path.join(res, f'mipmap-{d}')
    os.makedirs(folder, exist_ok=True)
    sq = Image.new('RGBA', (px, px), BG)
    sq.alpha_composite(compose(px, 0.9))
    sq.convert('RGB').save(os.path.join(folder, 'ic_launcher.png'))
    rnd = sq.copy()
    mask = Image.new('L', (px, px), 0)
    from PIL import ImageDraw
    ImageDraw.Draw(mask).ellipse((0, 0, px - 1, px - 1), fill=255)
    rnd.putalpha(mask)
    rnd.save(os.path.join(folder, 'ic_launcher_round.png'))
    compose(fore[d], 0.62).save(os.path.join(folder, 'ic_launcher_foreground.png'))

bgxml = os.path.join(res, 'values/ic_launcher_background.xml')
os.makedirs(os.path.dirname(bgxml), exist_ok=True)
open(bgxml, 'w').write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#CFF3F0</color>\n</resources>\n')
# --- Launch splash: dark background with the mascot (replaces Capacitor's default image)
for dirpath, _, files in os.walk(res):
    if 'splash.png' in files and os.path.basename(dirpath).startswith('drawable'):
        target = os.path.join(dirpath, 'splash.png')
        w, h = Image.open(target).size
        base = Image.new('RGBA', (w, h), (5, 8, 17, 255))
        side = int(min(w, h) * 0.42)
        m = mascot.resize((side, side), Image.LANCZOS)
        base.alpha_composite(m, ((w - side) // 2, (h - side) // 2))
        base.convert('RGB').save(target)
print('patched', android)

# --- Android 12+ system splash: dark background, no small icon (the web splash follows immediately)
st = os.path.join(res, 'values/styles.xml')
t = open(st).read()
t = t.replace('<style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">\n        <item name="android:background">@drawable/splash</item>',
 '<style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">\n        <item name="android:background">@drawable/splash</item>\n        <item name="windowSplashScreenBackground">#050811</item>\n        <item name="windowSplashScreenAnimatedIcon">@drawable/rk_blank</item>\n        <item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>')
open(st, 'w').write(t)
open(os.path.join(res, 'drawable/rk_blank.xml'), 'w').write('<?xml version="1.0" encoding="utf-8"?>\n<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle"><solid android:color="#00000000"/><size android:width="1dp" android:height="1dp"/></shape>\n')
print('splash theme patched', 'windowSplashScreenBackground' in t)

# --- Push notifications (Firebase). Only active when google-services.json was placed in app/ by the workflow.
gs = os.path.join(android, 'app/google-services.json')
if os.path.exists(gs):
    g = open(gr).read()
    if 'com.google.gms.google-services' not in g:
        g += "\napply plugin: 'com.google.gms.google-services'\n"
        open(gr, 'w').write(g)
    rb = os.path.join(android, 'build.gradle')
    r = open(rb).read()
    if 'com.google.gms:google-services' not in r:
        r = re.sub(r"(dependencies\s*\{)", r"\1\n        classpath 'com.google.gms:google-services:4.4.2'", r, count=1)
        open(rb, 'w').write(r)
    print('Push notifications: google-services.json found, Firebase enabled')
else:
    print('Push notifications: no google-services.json, building without Firebase push')
