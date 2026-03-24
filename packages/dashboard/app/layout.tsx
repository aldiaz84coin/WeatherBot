// packages/dashboard/app/layout.tsx
import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Madrid Temp Bot',
  description: 'Polymarket temperature prediction bot for Madrid',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body className="bg-gray-950 text-gray-100 min-h-screen">
        <nav className="border-b border-gray-800 px-6 py-3 flex items-center gap-6 flex-wrap">
          <span className="text-white font-semibold tracking-tight">🌡️ Madrid Temp Bot</span>
          <a href="/"           className="text-sm text-gray-400 hover:text-white transition-colors">Overview</a>
          <a href="/predictions" className="text-sm text-gray-400 hover:text-white transition-colors">Predicciones</a>
          <a href="/training"   className="text-sm text-gray-400 hover:text-white transition-colors">Entrenamiento</a>
          <a href="/comparison" className="text-sm text-gray-400 hover:text-white transition-colors">
            📊 Comparativa
          </a>
          <a href="/betting"    className="text-sm text-gray-400 hover:text-white transition-colors">
            🎯 Apuestas
          </a>
          <a href="/config"     className="text-sm text-gray-400 hover:text-white transition-colors">
            ⚙️ Configuración
          </a>
        </nav>
        <main className="max-w-6xl mx-auto px-6 py-8">
          {children}
        </main>
      </body>
    </html>
  )
}
