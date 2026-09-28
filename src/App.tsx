import React from 'react';
import { ModernVueCompressor } from './components/ModernVueCompressor';

export default function App() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-center font-sans antialiased selection:bg-[#E0533C]/30 selection:text-orange-200">
      <main className="max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <ModernVueCompressor />
      </main>
    </div>
  );
}
