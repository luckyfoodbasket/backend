const cron = require('node-cron');
const axios = require('axios');
const logger = require('../utils/logger'); // Assuming you have a logger, based on index.js

const keepAliveService = {
    init: () => {
        // Schedule a task to run every 3 minutes
        cron.schedule('*/3 * * * *', async () => {
            try {
                const port = process.env.PORT || 5000;
                const response = await axios.get(`http://localhost:${port}/`);
                logger.info(`Keep-alive ping successful: ${response.status}`);
            } catch (error) {
                logger.error('Keep-alive ping failed:', error.message);
            }
        });

        logger.info('Keep-alive service initialized (running every 3 minutes)');
    }
};

module.exports = keepAliveService;
