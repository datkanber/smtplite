const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const SmtpClient = require('./smtp/smtpClient');
const logger = require('./utils/logger');

class SmtpLiteServer {
    constructor() {
        this.config = this.loadConfig();
        this.smtpClient = new SmtpClient(this.config.smtp);
    }

    loadConfig() {
        try {
            const configPath = path.join(__dirname, 'config', 'config.json');
            const configData = fs.readFileSync(configPath, 'utf8');
            return JSON.parse(configData);
        } catch (error) {
            console.error('Failed to load config:', error.message);
            logger.error(`Failed to load configuration: ${error.message}`, 'configLoad');
            process.exit(1);
        }
    }

    validateApiKey(key) {
        return key === this.config.apiKey;
    }

    validateEmailParams(params) {
        const required = ['key', 'to', 'subject', 'text'];
        for (const param of required) {
            if (!params[param]) {
                return { valid: false, missing: param };
            }
        }
        return { valid: true };
    }

    async handleSendRequest(req, res) {
        let params;
        try {
            const parsedUrl = url.parse(req.url, true);
            params = parsedUrl.query;

            // Validate required parameters
            const validation = this.validateEmailParams(params);
            if (!validation.valid) {
                const errorMsg = `Missing required parameter: ${validation.missing}`;
                logger.warn(errorMsg, 'apiRequest', { 
                    endpoint: '/send',
                    missingParam: validation.missing 
                });
                
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: errorMsg }));
                return;
            }

            // Validate API key
            if (!this.validateApiKey(params.key)) {
                logger.warn('Invalid API key used', 'apiRequest', { 
                    endpoint: '/send',
                    recipient: params.to 
                });
                
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid API key' }));
                return;
            }

            // Decode URL-encoded text
            const decodedText = decodeURIComponent(params.text.replace(/\+/g, ' '));

            // Send email via SMTP
            const emailData = {
                to: params.to,
                subject: params.subject,
                text: decodedText
            };

            await this.smtpClient.sendEmail(emailData);

            // Log successful send
            logger.emailSent(params.to, params.subject);
            logger.apiRequest('GET', '/send', {
                to: params.to,
                subject: params.subject
            }, 200);

            // Return success response
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'sent',
                to: params.to
            }));

        } catch (error) {
            console.error('Send email error:', error.message);
            
            if (params) {
                logger.emailFailed(params.to, params.subject, error.message);
                logger.apiRequest('GET', '/send', {
                    to: params.to,
                    subject: params.subject,
                    error: error.message
                }, 500);
            } else {
                logger.error(`Send email error: ${error.message}`, 'sendEmail');
            }
            
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to send email' }));
        }
    }

    handleRequest(req, res) {
        const parsedUrl = url.parse(req.url, true);
        
        if (req.method === 'GET' && parsedUrl.pathname === '/send') {
            this.handleSendRequest(req, res);
        } else {
            logger.warn(`Endpoint not found: ${parsedUrl.pathname}`, 'apiRequest', {
                method: req.method,
                endpoint: parsedUrl.pathname
            });
            
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Endpoint not found' }));
        }
    }

    start() {
        const server = http.createServer((req, res) => {
            this.handleRequest(req, res);
        });

        const PORT = 8080;
        server.listen(PORT, () => {
            console.log(`SmtpLite server running on port ${PORT}`);
            logger.serverStarted(PORT);
        });
    }
}

// Start the server
const smtpLiteServer = new SmtpLiteServer();
smtpLiteServer.start();
