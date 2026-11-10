# Evacuation zones for the whole Southern California megaregion: a hex tessellation of all land,
# each hex named after its nearest OpenStreetMap place (city, town, neighbourhood...).
# Usage: python3 -I tools/build_zones.py <cache_dir>   -> writes web/src/zonesData.ts
# Data: OSM place nodes via Overpass (ODbL), AWS Terrain Tiles (Terrarium) for land/relief.
import io, json, math, os, re, sys, unicodedata, urllib.parse, urllib.request
from PIL import Image

CACHE = sys.argv[1]
os.makedirs(CACHE, exist_ok=True)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'web', 'src', 'zonesData.ts')

# Region: Santa Maria / Lancaster / Barstow (N) to the Mexican border (S), Point Conception (W) to the Imperial Valley (E).
NORTH, SOUTH, WEST, EAST = 35.15, 32.53, -120.65, -115.3
LAT0, LNG0 = 33.8, -117.9  # projection origin (equirectangular, affine: hexes tile exactly in lat/lng)
R = 2500.0  # hex circumradius, m (~5 km across)
KX = 111320 * math.cos(math.radians(LAT0))
KY = 111320.0
UA = {'User-Agent': 'FireFly-zone-builder (hackathon demo)'}


def border_lat(lng):  # US-Mexico border is a straight line from the Pacific to the Colorado River
    a, b = (-117.1241, 32.5343), (-114.7196, 32.7186)
    return a[1] + (lng - a[0]) * (b[1] - a[1]) / (b[0] - a[0])


def to_xy(lat, lng): return ((lng - LNG0) * KX, (lat - LAT0) * KY)
def to_ll(x, y): return (LAT0 + y / KY, LNG0 + x / KX)
def hex_center(q, r): return (R * math.sqrt(3) * (q + r / 2), R * 1.5 * r)


# ---------- places ----------
def places():
    fn = os.path.join(CACHE, 'places.json')
    if not os.path.exists(fn):
        q = f"""[out:json][timeout:180];
area["ISO3166-2"="US-CA"]->.ca;
node["place"~"^(city|town|village|suburb|neighbourhood|quarter|hamlet)$"]["name"](area.ca)({SOUTH},{WEST},{NORTH},{EAST});
out body;"""
        req = urllib.request.Request('https://overpass-api.de/api/interpreter', data=urllib.parse.urlencode({'data': q}).encode(), headers=UA)
        open(fn, 'wb').write(urllib.request.urlopen(req, timeout=240).read())
    els = json.load(open(fn))['elements']
    out = []
    for e in els:
        name = str(e.get('tags', {}).get('name', '')).strip()
        if not name or len(name) > 40 or not re.fullmatch(r"[\w .,'’()&/-]+", name):
            continue
        out.append((e['lat'], e['lon'], name, e['tags']['place']))
    return out


# Larger places win ties: a hex between a city centre and a hamlet takes the city's name sooner.
WEIGHT = {'city': 0.7, 'town': 0.8, 'suburb': 0.85, 'quarter': 0.9, 'village': 0.9, 'neighbourhood': 1.0, 'hamlet': 1.1}


# ---------- elevation (Terrarium, z10 ~ 130 m/px) ----------
Z = 10
_tiles = {}


def tile(x, y):
    if (x, y) not in _tiles:
        fn = os.path.join(CACHE, f'dem_{Z}_{x}_{y}.png')
        if not os.path.exists(fn):
            req = urllib.request.Request(f'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{Z}/{x}/{y}.png', headers=UA)
            open(fn, 'wb').write(urllib.request.urlopen(req, timeout=30).read())
        _tiles[(x, y)] = Image.open(io.BytesIO(open(fn, 'rb').read())).convert('RGB').load()
    return _tiles[(x, y)]


def elev(lat, lng):
    n = 256 * 2 ** Z
    s = math.sin(math.radians(lat))
    px = (lng + 180) / 360 * n
    py = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    r, g, b = tile(int(px // 256), int(py // 256))[int(px % 256), int(py % 256)]
    return r * 256 + g + b / 256 - 32768


def is_land(lat, lng, e):
    if lat < border_lat(lng) or not (SOUTH <= lat <= NORTH and WEST <= lng <= EAST):
        return False
    if lng > -117.0:  # inland deserts dip below sea level (Coachella, Imperial Valley); no ocean east of here
        return e > -100
    return e > 0.5


# ---------- zone codes ----------
def ascii_upper(s): return unicodedata.normalize('NFD', s).encode('ascii', 'ignore').decode().upper()


def code_options(name):
    words = [w for w in re.split(r"[^A-Z]+", ascii_upper(re.sub(r'^Near ', '', name))) if w]
    if not words:
        return ['Z']
    opts = []
    if len(words) == 1:
        w = words[0]
        opts += [w[:3], w[:2] + w[-1], w[:4]]
    else:
        ini = ''.join(w[0] for w in words)[:4]
        opts += [ini, ini + words[-1][1:2], words[0][:2] + words[-1][:2], ini + words[-1][1:3]]
    return [o for o in opts if o]


def main():
    pl = places()
    print(f'{len(pl)} places', file=sys.stderr)
    pxy = [(*to_xy(la, lo), nm, WEIGHT[k]) for la, lo, nm, k in pl]
    # lattice range covering the region
    xs = [to_xy(la, lo)[0] for la in (SOUTH, NORTH) for lo in (WEST, EAST)]
    ys = [to_xy(la, lo)[1] for la in (SOUTH, NORTH) for lo in (WEST, EAST)]
    rmin, rmax = math.floor(min(ys) / (1.5 * R)) - 1, math.ceil(max(ys) / (1.5 * R)) + 1
    # 19 samples per hex: centre, 6 at 0.45R, 12 at 0.85R
    offs = [(0, 0)] + [(0.45 * R * math.cos(a), 0.45 * R * math.sin(a)) for a in [k * math.pi / 3 + math.pi / 6 for k in range(6)]]
    offs += [(0.85 * R * math.cos(a), 0.85 * R * math.sin(a)) for a in [k * math.pi / 6 for k in range(12)]]
    hexes = []
    for r in range(rmin, rmax + 1):
        qmin = math.floor(min(xs) / (R * math.sqrt(3)) - r / 2) - 1
        qmax = math.ceil(max(xs) / (R * math.sqrt(3)) - r / 2) + 1
        for q in range(qmin, qmax + 1):
            cx, cy = hex_center(q, r)
            clat, clng = to_ll(cx, cy)
            if not (SOUTH - 0.03 <= clat <= NORTH + 0.03 and WEST - 0.03 <= clng <= EAST + 0.03):
                continue
            land = []
            for dx, dy in offs:
                la, lo = to_ll(cx + dx, cy + dy)
                e = elev(la, lo)
                if is_land(la, lo, e):
                    land.append(e)
            if len(land) < 2:
                continue
            relief = max(land) - min(land)
            # Clearance (approximate): canyons and mountains have few exits; flat basin has a road grid.
            clearance = 90 if relief > 450 else 60 if relief > 150 else 45
            best, bd, raw = None, float('inf'), 0.0
            for px, py, nm, w in pxy:
                d = math.hypot(px - cx, py - cy)
                if d * w < bd:
                    bd, best, raw = d * w, nm, d
            name = best or 'Unnamed area'
            if raw > 8000:  # remote land (desert, mountains): say it is only near the place
                name = f'Near {name}'
            hexes.append({'q': q, 'r': r, 'name': name, 'clr': clearance, 'lat': clat, 'lng': clng})
    print(f'{len(hexes)} land hexes', file=sys.stderr)
    # IDs: short code per place name + running number (north-west first), e.g. "PAS-2" = 2nd Pasadena zone
    taken = {}
    code_of = {}
    for nm in sorted({h['name'] for h in hexes}):
        base = code_options(nm)
        if nm.startswith('Near '):
            base = ['X' + b for b in base]  # remote zones: X prefix, e.g. XKEL-3 = remote land near Kelso
        for c in base + [f'{base[0]}{k}' for k in range(2, 50)]:
            if c not in taken:
                taken[c] = nm
                code_of[nm] = c
                break
    count = {}
    hexes.sort(key=lambda h: (-round(h['lat'], 2), h['lng']))
    rows = []
    for h in hexes:
        k = count[h['name']] = count.get(h['name'], 0) + 1
        rows.append([h['q'], h['r'], f"{code_of[h['name']]}-{k}", h['name'], h['clr']])
    with open(OUT, 'w') as f:
        f.write('// GENERATED by tools/build_zones.py. Do not edit by hand.\n')
        f.write('// Hex evacuation zones covering all land in the Southern California megaregion.\n')
        f.write('// Names: nearest OpenStreetMap place (© OpenStreetMap contributors, ODbL). Clearance minutes are approximate (from terrain relief).\n')
        f.write(f'export const HEX = {json.dumps({"north": NORTH, "south": SOUTH, "west": WEST, "east": EAST, "lat0": LAT0, "lng0": LNG0, "radiusM": R})};\n')
        f.write('// [q, r, id, name, clearanceMin]\n')
        f.write('export const ZONE_ROWS: [number, number, string, string, number][] = [\n')
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + ',\n')
        f.write('];\n')
    print(f'wrote {OUT} ({len(rows)} zones, {len(code_of)} names)', file=sys.stderr)


main()
