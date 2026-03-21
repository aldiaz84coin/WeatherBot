// components/KpiCard.tsx
interface Props {
  label: string
  value: string
  sublabel?: string
  highlight?: boolean
  positive?: boolean
}

export function KpiCard({ label, value, sublabel, highlight, positive }: Props) {
  const valueColor = positive === true
    ? 'text-green-400'
    : positive === false
      ? 'text-red-400'
      : highlight
        ? 'text-green-400'
        : 'text-white'

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-xl font-semibold ${valueColor}`}>{value}</p>
      {sublabel && <p className="text-xs text-gray-600 mt-1">{sublabel}</p>}
    </div>
  )
}
