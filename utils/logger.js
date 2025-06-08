const fs = require('fs');
const path = require('path');

class Logger {
    constructor() {
        this.logFile = path.join(__dirname, '..', 'logs', 'mail.log');
        this.ensureLogDirectory();
    }

    ensureLogDirectory() {
        const logDir = path.dirname(this.logFile);
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
    }

    log(message, level = 'INFO', event = 'general', metadata = {}) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            level: level.toUpperCase(),
            event: event,
            message: message,
            ...metadata
        };
        
        const logLine = JSON.stringify(logEntry) + '\n';
        
        fs.appendFile(this.logFile, logLine, (err) => {
            if (err) {
                console.error('Failed to write to log file:', err.message);
            }
        });
    }

    info(message, event = 'general', metadata = {}) {
        this.log(message, 'INFO', event, metadata);
    }

    error(message, event = 'general', metadata = {}) {
        this.log(message, 'ERROR', event, metadata);
    }

    warn(message, event = 'general', metadata = {}) {
        this.log(message, 'WARN', event, metadata);
    }

    // Convenience methods for email events
    emailSent(to, subject) {
        this.info(`Email sent successfully`, 'sendEmail', {
            recipient: to,
            subject: subject
        });
    }

    emailFailed(to, subject, error) {
        this.error(`Failed to send email: ${error}`, 'sendEmail', {
            recipient: to,
            subject: subject,
            errorDetails: error
        });
    }

    serverStarted(port) {
        this.info(`SmtpLite server started on port ${port}`, 'serverStart', {
            port: port
        });
    }

    apiRequest(method, endpoint, params, status) {
        this.info(`API request processed`, 'apiRequest', {
            method: method,
            endpoint: endpoint,
            parameters: params,
            statusCode: status
        });
    }
}

module.exports = new Logger();
