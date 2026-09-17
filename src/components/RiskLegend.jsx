import React from 'react';

export default function RiskLegend() {
    return (
        <div className="absolute bottom-5 left-5 z-[1000] bg-slate-900/90 text-white backdrop-blur-md rounded-xl p-3.5 border border-slate-700/60 shadow-xl max-w-[220px]">
            <div className="text-xs font-semibold text-slate-200 mb-2">
                Debris Accumulation Risk
            </div>
            <div
                className="w-full h-2.5 rounded-full"
                style={{
                    background: 'linear-gradient(to right, #1a237e, #2196f3, #ffeb3b, #ff9800, #d32f2f)'
                }}
            />
            <div className="flex justify-between text-[10px] text-slate-400 mt-1.5 font-medium">
                <span>Low</span>
                <span>Mod</span>
                <span>High</span>
                <span>Crit</span>
            </div>
            <div className="mt-2.5 pt-2 border-t border-slate-800 text-[10px] text-slate-400 leading-tight">
                Aggregated from port proximity, fishing density, river inflow & bathymetry.
            </div>
        </div>
    );
}