'use client';

import { useState } from 'react';
import { EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline';
import PasswordRequirements from './PasswordRequirements';

export default function NewPasswordFields({
    register,
    watch,
    errors,
    idPrefix,
    passwordName = 'password',
    passwordLabel = 'New password',
    confirmationLabel = 'Confirm new password',
    passwordPlaceholder,
    confirmationPlaceholder,
}) {
    const [showPassword, setShowPassword] = useState(false);
    const [showConfirmation, setShowConfirmation] = useState(false);
    const passwordValue = watch(passwordName) || '';
    const confirmationValue = watch('confirmPassword') || '';
    const confirmationError = confirmationValue
        ? (confirmationValue === passwordValue ? '' : "Passwords don't match")
        : errors.confirmPassword?.message;
    const requirementsId = `${idPrefix}-password-requirements`;
    const confirmationErrorId = `${idPrefix}-confirmation-error`;

    return (
        <>
            <div>
                <label htmlFor={`${idPrefix}-password`} className="label">{passwordLabel}</label>
                <div className="relative">
                    <input
                        id={`${idPrefix}-password`}
                        {...register(passwordName)}
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="new-password"
                        aria-invalid={Boolean(errors[passwordName])}
                        aria-describedby={requirementsId}
                        placeholder={passwordPlaceholder}
                        className="input pr-10"
                    />
                    <button
                        type="button"
                        aria-label={showPassword ? 'Hide new password' : 'Show new password'}
                        aria-pressed={showPassword}
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400"
                    >
                        {showPassword ? <EyeSlashIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
                    </button>
                </div>
                <PasswordRequirements password={passwordValue} id={requirementsId} />
            </div>
            <div>
                <label htmlFor={`${idPrefix}-confirm-password`} className="label">{confirmationLabel}</label>
                <div className="relative">
                    <input
                        id={`${idPrefix}-confirm-password`}
                        {...register('confirmPassword')}
                        type={showConfirmation ? 'text' : 'password'}
                        autoComplete="new-password"
                        aria-invalid={Boolean(confirmationError)}
                        aria-describedby={confirmationError ? confirmationErrorId : undefined}
                        placeholder={confirmationPlaceholder}
                        className="input pr-10"
                    />
                    <button
                        type="button"
                        aria-label={showConfirmation ? 'Hide confirmed password' : 'Show confirmed password'}
                        aria-pressed={showConfirmation}
                        onClick={() => setShowConfirmation(!showConfirmation)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400"
                    >
                        {showConfirmation ? <EyeSlashIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
                    </button>
                </div>
                {confirmationError && (
                    <p id={confirmationErrorId} className="error-text" aria-live="polite">
                        {confirmationError}
                    </p>
                )}
            </div>
        </>
    );
}
