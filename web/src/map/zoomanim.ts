// Smooth zoom for map-sized canvases: scale/translate the canvas along with Leaflet's zoom
// animation (same maths as Leaflet's own canvas renderer), and let callers skip redraws meanwhile.
import L from 'leaflet';

type MapInternals = L.Map & { _getNewPixelOrigin(center: L.LatLng, zoom: number): L.Point };

export function attachZoomAnim(map: L.Map, canvas: HTMLCanvasElement, onEnd: () => void): { zooming: () => boolean } {
  let zooming = false;
  canvas.classList.add('leaflet-zoom-animated');
  map.on('zoomanim', (e: L.ZoomAnimEvent) => {
    zooming = true;
    // the canvas covers the viewport as it was when the animation started
    const scale = map.getZoomScale(e.zoom, map.getZoom());
    const viewHalf = map.getSize().multiplyBy(0.5);
    const currentCenterPoint = map.project(map.getCenter(), e.zoom);
    const topLeft = viewHalf
      .multiplyBy(-scale)
      .add(currentCenterPoint)
      .subtract((map as MapInternals)._getNewPixelOrigin(e.center, e.zoom));
    L.DomUtil.setTransform(canvas, topLeft, scale);
  });
  map.on('zoomend', () => {
    zooming = false;
    onEnd();
  });
  return { zooming: () => zooming };
}
