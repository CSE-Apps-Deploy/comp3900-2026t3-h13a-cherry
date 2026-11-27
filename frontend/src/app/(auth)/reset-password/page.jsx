import { Suspense } from 'react';
import Link from 'next/link';
import PasswordResetForm from '../../../components/PasswordResetForm';

export const metadata = { title: 'Reset password | TutorConnect', referrer: 'no-referrer' };

export default function ResetPasswordPage() {
    return (
        <div className="min-h-screen bg-white px-6 py-12">
            <div className="mx-auto max-w-md space-y-6">
                <Link href="/login" className="text-sm text-gray-500">
                    ← Back to login
                </Link>
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">Reset your password</h1>
                    <p className="mt-2 text-sm text-gray-500">
                        Set a new password for your TutorConnect account.
                    </p>
                </div>
                <Suspense
                    fallback={<p className="text-sm text-gray-500">Checking reset link...</p>}
                >
                    <PasswordResetForm />
                </Suspense>
            </div>
        </div>
    );
}
