import { useEffect } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet.heat';

export default function HeatmapLayer({ points, options = {} }) {
    const map = useMap();

    useEffect(() => {
        if (!map || !points || points.length === 0) return;

        const heat = L.heatLayer(points, {
            radius: 38,
            blur: 28,
            maxZoom: 10,
            max: 1.0,
            minOpacity: 0.35,
            gradient: {
                0.0: '#1a237e',  // Deep blue — minimal risk
                0.25: '#2196f3', // Blue — low risk
                0.5: '#ffeb3b',  // Yellow — moderate risk
                0.75: '#ff9800', // Orange — high risk
                1.0: '#d32f2f',  // Red — critical risk
            },
            ...options,
        });

        heat.addTo(map);

        // leaflet.heat has no built-in overall-opacity option (minOpacity
        // only floors the low end) — dial back the canvas itself so the
        // basemap labels stay legible under dense/critical clusters.
        if (heat._canvas) heat._canvas.style.opacity = '0.55';

        return () => {
            map.removeLayer(heat);
        };
    }, [map, points, options]);

    return null;
}