import { getPasswordRequirements } from '../lib/password-policy';

export default function PasswordRequirements({ password = '', id }) {
    return (
        <div id={id} className="mt-3 space-y-2">
            <ul aria-label="Password requirements" className="space-y-1.5 text-xs">
                {getPasswordRequirements(password).map((rule) => (
                    <li
                        key={rule.id}
                        aria-label={`${rule.label}: ${rule.met ? 'met' : 'not met'}`}
                        className={`flex items-center gap-2 ${rule.met ? 'text-emerald-700' : 'text-red-600'}`}
                    >
                        <span className="w-4 shrink-0 text-center font-semibold" aria-hidden="true">
                            {rule.met ? '√' : 'X'}
                        </span>
                        <span>{rule.label}</span>
                    </li>
                ))}
            </ul>
            <p className="text-xs text-gray-500">
                {'Supported symbols: ! @ # $ % ^ & * ( ) , . ? " : { } | < >'}
            </p>
        </div>
    );
}
