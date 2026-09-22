export const getApiUrl = (): string => {
    if (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL) {
        return process.env.NEXT_PUBLIC_API_URL;
    }
    if (typeof window !== 'undefined') {
        const host = window.location.hostname;
        if (host === 'localhost' || host === '127.0.0.1' || host.startsWith('192.168.') || host.startsWith('10.')) {
            // Use Next.js proxy rewrite to avoid CORS and port mapping issues completely
            return `/api/backend`;
        }
    }
    return 'https://samd445-jetset-ai.hf.space';
};
