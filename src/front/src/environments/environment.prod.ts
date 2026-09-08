export const environment = {
    production: true,
    // Overridden at container start by entrypoint.sh writing /config.json — see ConfigService.
    apiUrl: '/api/',
    wsUrl: '/ws',
};
