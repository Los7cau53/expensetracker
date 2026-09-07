import { ComboBox } from './ComboBox'
import { payeeRoleOptions, type PayeeRole } from '../db/schema'

export function PayeeRolePicker({
  roles,
  value,
  onChange,
}: {
  roles?: PayeeRole[]
  value: PayeeRole
  onChange: (role: PayeeRole) => void
}) {
  const options = payeeRoleOptions([...(roles ?? []), value])

  return (
    <ComboBox
      options={options.map((role) => ({ id: role, name: role }))}
      value={value}
      onChange={(role) => {
        if (role) onChange(role)
      }}
      onCreate={async (role) => role.trim()}
      placeholder="Pick or add a role…"
    />
  )
}
