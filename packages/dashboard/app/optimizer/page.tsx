// packages/dashboard/app/optimizer/page.tsx

import { AIOptimizer } from '../../components/AIOptimizer'

export const revalidate = 0

export default function OptimizerPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">Optimizador IA</h1>
        <p className="text-gray-400 text-sm mt-1">
          Recalibración de pesos y bias mediante análisis del historial liquidado
        </p>
      </div>
      <AIOptimizer />
    </div>
  )
}
