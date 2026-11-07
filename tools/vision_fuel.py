# Vision land-cover labels for the LA grid: one OpenRouter call per z14 Esri tile -> 4x4 labels.
# Usage: python3 tools/vision_fuel.py <work_dir> full   (then copy <work_dir>/vision_landcover.json to web/public/landcover/vision_la.json)
# Uses OPENROUTER_API_KEY from server/.env. ~465 calls, ~$1.30 with google/gemini-3.8-flash (Nov 2026).
import base64, json, math, os, sys, time, urllib.request, concurrent.futures as cf
OUT = sys.argv[1]; MODE = sys.argv[2] if len(sys.argv) > 2 else 'test'
MODEL = os.environ.get('VISION_MODEL', 'google/gemini-3.8-flash')
env = {}
for line in open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'server', '.env')):
    if '=' in line and not line.startswith('#'): k, v = line.rstrip('\n').split('=', 1); env[k.strip()] = v.strip()
KEY = env['OPENROUTER_API_KEY']
CENTER=(34.13,-118.34); W=1000; H=480; CELL=60
DLAT=CELL/111320; DLNG=CELL/(111320*math.cos(math.radians(CENTER[0])))
NORTH=CENTER[0]+H*DLAT/2; SOUTH=CENTER[0]-H*DLAT/2; WEST=CENTER[1]-W*DLNG/2; EAST=CENTER[1]+W*DLNG/2
Z=14
def tile_xy(lat,lng):
    n=2**Z; s=math.sin(math.radians(lat)); return int((lng+180)/360*n), int((0.5-math.log((1+s)/(1-s))/(4*math.pi))*n)
def tile_bounds(x,y):
    n=2**Z; lng0=x/n*360-180; lng1=(x+1)/n*360-180
    lat=lambda yy: math.degrees(math.atan(math.sinh(math.pi*(1-2*yy/n)))); return lat(y), lat(y+1), lng0, lng1  # north, south, west, east
PROMPT = """Satellite image tile of Los Angeles, ~2 km across, north up. Split it into a 4x4 grid of equal blocks (row 1 = top, column 1 = left).
Label each block with ONE letter for its DOMINANT land cover, as a wildfire fuel map:
W water | G dry grass | C chaparral/scrub/brush | F dense trees or forest canopy (wildland) | U homes among trees/brush (wildland-urban interface, single-family on hillsides or canyons) | D dense city (commercial, apartments, freeways, mostly pavement/roofs) | S suburban grid (houses with yards, flat, few wildland plants) | I irrigated green (golf course, park lawn, cemetery, sports field) | B bare rock/dirt/sand/beach
IMPORTANT: if a residential area looks recently burned (gray/brown lots, foundations, missing roofs in a street pattern), label it what it WAS: U or S. Burned hillside brush stays C.
Reply with ONLY JSON: {"grid":["XXXX","XXXX","XXXX","XXXX"]}"""
def fetch_tile(x,y):
    fn=f'{OUT}/t_{x}_{y}.jpg'
    if not os.path.exists(fn):
        req=urllib.request.Request(f'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{Z}/{y}/{x}', headers={'User-Agent':'FireFly-vision-fuel'})
        open(fn,'wb').write(urllib.request.urlopen(req,timeout=20).read())
    return open(fn,'rb').read()
def classify(x,y):
    cache=f'{OUT}/r_{x}_{y}.json'
    if os.path.exists(cache): return json.load(open(cache))
    img=base64.b64encode(fetch_tile(x,y)).decode()
    body={'model':MODEL,'max_tokens':1200,'reasoning':{'effort':'low'},'messages':[{'role':'user','content':[{'type':'text','text':PROMPT},{'type':'image_url','image_url':{'url':'data:image/jpeg;base64,'+img}}]}]}
    for attempt in range(3):
        try:
            req=urllib.request.Request('https://openrouter.ai/api/v1/chat/completions', data=json.dumps(body).encode(), headers={'Authorization':'Bearer '+KEY,'Content-Type':'application/json','X-Title':'FireFly'})
            d=json.loads(urllib.request.urlopen(req,timeout=60).read())
            txt=d['choices'][0]['message']['content']; j=json.loads(txt[txt.index('{'):txt.rindex('}')+1])
            g=[str(r).upper().strip()[:4] for r in j['grid']][:4]
            assert len(g)==4 and all(len(r)==4 for r in g)
            res={'x':x,'y':y,'grid':g,'cost':d.get('usage',{}).get('cost',0)}
            json.dump(res,open(cache,'w')); return res
        except Exception as e:
            err=str(e); time.sleep(2*(attempt+1))
    return {'x':x,'y':y,'error':err}
x0,y0=tile_xy(NORTH,WEST); x1,y1=tile_xy(SOUTH,EAST)
tiles=[(x,y) for y in range(y0,y1+1) for x in range(x0,x1+1)]
if MODE=='test':
    pick=[tile_xy(34.046,-118.527), tile_xy(34.146,-118.140), tile_xy(34.225,-118.100)]  # Palisades homes, Pasadena dense, San Gabriel chaparral
    for (x,y),name in zip(pick,['Pacific Palisades','downtown Pasadena','San Gabriel Mtns']):
        r=classify(x,y); print(name.ljust(18), r.get('grid'), r.get('error',''), 'cost', r.get('cost'))
else:
    print('tiles', len(tiles), file=sys.stderr)
    out=[]; cost=0; fails=0
    with cf.ThreadPoolExecutor(8) as ex:
        for i,r in enumerate(ex.map(lambda t: classify(*t), tiles)):
            out.append(r); cost+=r.get('cost') or 0; fails+= 'error' in r
            if i%50==0: print(f'{i}/{len(tiles)} cost ${cost:.3f} fails {fails}', file=sys.stderr, flush=True)
    meta={'model':MODEL,'zoom':Z,'blocks':4,'tiles':[{'x':r['x'],'y':r['y'],'grid':r['grid']} for r in out if 'grid' in r]}
    json.dump(meta,open(f'{OUT}/vision_landcover.json','w'))
    print(f'done: {len(meta["tiles"])}/{len(tiles)} tiles, cost ${cost:.3f}, fails {fails}', file=sys.stderr)
