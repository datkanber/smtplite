const net = require('net');
const tls = require('tls');

class SmtpClient {
    constructor(config) {
        this.host = config.host;
        this.port = config.port;
        this.username = config.username;
        this.password = config.password;
        this.from = config.from;
        this.secure = config.secure || false;
        this.timeout = config.timeout || 10000;
    }

    async sendEmail(emailData) {
        return new Promise((resolve, reject) => {
            let socket;
            let currentStep = 0;
            let buffer = '';
            let isSecure = false;
            let timeoutHandle;
            let needsStartTls = false;
            let multilineBuffer = '';
            let waitingForCompleteResponse = false;

            const setupTimeout = (sock) => {
                this.clearTimeoutHandle();
                timeoutHandle = setTimeout(() => {
                    sock.destroy();
                    reject(new Error('SMTP connection timeout'));
                }, this.timeout);
            };

            const clearTimeoutHandle = () => {
                if (timeoutHandle) {
                    global.clearTimeout(timeoutHandle);
                    timeoutHandle = null;
                }
            };

            this.clearTimeoutHandle = clearTimeoutHandle;

            // Use a socket reference object that can be updated
            const socketRef = { current: null };

            const steps = [
                { name: 'greeting', handler: () => this.waitForGreeting() },
                { name: 'ehlo', handler: () => this.sendCommand(socketRef.current, `EHLO ${this.host}`) },
                { name: 'starttls', handler: () => this.handleStartTls(socketRef.current) },
                { name: 'ehlo2', handler: () => this.sendCommand(socketRef.current, `EHLO ${this.host}`) },
                { name: 'auth', handler: () => this.sendCommand(socketRef.current, 'AUTH LOGIN') },
                { name: 'username', handler: () => this.sendCommand(socketRef.current, Buffer.from(this.username).toString('base64')) },
                { name: 'password', handler: () => this.sendCommand(socketRef.current, Buffer.from(this.password).toString('base64')) },
                { name: 'mailfrom', handler: () => this.sendCommand(socketRef.current, `MAIL FROM:<${this.from}>`) },
                { name: 'rcptto', handler: () => this.sendCommand(socketRef.current, `RCPT TO:<${emailData.to}>`) },
                { name: 'data', handler: () => this.sendCommand(socketRef.current, 'DATA') },
                { name: 'content', handler: () => this.sendEmailContent(socketRef.current, emailData) },
                { name: 'quit', handler: () => this.sendCommand(socketRef.current, 'QUIT') }
            ];

            const connectWithTls = () => {
                socket = tls.connect({
                    host: this.host,
                    port: this.port,
                    rejectUnauthorized: false
                }, () => {
                    console.log('TLS connection established');
                    isSecure = true;
                    socketRef.current = socket;
                    setupTimeout(socket);
                });
                this.setupSocketHandlers(socket, resolve, reject, clearTimeoutHandle);
            };

            const connectPlain = () => {
                socket = new net.Socket();
                socketRef.current = socket;
                setupTimeout(socket);
                
                socket.connect(this.port, this.host, () => {
                    console.log('Connected to SMTP server');
                    if (this.port === 587) {
                        needsStartTls = true;
                    }
                });
                this.setupSocketHandlers(socket, resolve, reject, clearTimeoutHandle);
            };

            const isMultilineResponse = (line) => {
                return line.length >= 4 && line.charAt(3) === '-';
            };

            const isCompleteResponse = (line) => {
                return line.length >= 4 && line.charAt(3) === ' ';
            };

            const handleResponse = (response) => {
                console.log(`SMTP Response [Step ${currentStep}]: ${response}`);

                // Handle multi-line responses
                if (isMultilineResponse(response)) {
                    multilineBuffer += response + '\n';
                    waitingForCompleteResponse = true;
                    return;
                } else if (waitingForCompleteResponse && isCompleteResponse(response)) {
                    // Complete multi-line response
                    multilineBuffer += response;
                    response = multilineBuffer;
                    multilineBuffer = '';
                    waitingForCompleteResponse = false;
                } else if (waitingForCompleteResponse) {
                    // Still in multi-line mode
                    multilineBuffer += response + '\n';
                    return;
                }

                const code = parseInt(response.substring(0, 3));

                if (code >= 400) {
                    clearTimeoutHandle();
                    socketRef.current.end();
                    reject(new Error(`SMTP error: ${response}`));
                    return;
                }

                const currentStepInfo = steps[currentStep];
                
                // Handle STARTTLS upgrade for port 587
                if (currentStepInfo.name === 'ehlo' && needsStartTls && !isSecure) {
                    if (response.includes('STARTTLS')) {
                        currentStep++; // Move to starttls step
                        setTimeout(() => steps[currentStep].handler(), 100);
                        return;
                    } else {
                        clearTimeoutHandle();
                        reject(new Error('STARTTLS not supported by server'));
                        return;
                    }
                }

                // Handle STARTTLS response
                if (currentStepInfo.name === 'starttls') {
                    if (code === 220) {
                        this.upgradeToTls(socketRef.current, resolve, reject, setupTimeout, clearTimeoutHandle, (tlsSocket) => {
                            // Update socket reference after TLS upgrade
                            socketRef.current = tlsSocket;
                            isSecure = true;
                            currentStep = 3; // Move to ehlo2 step
                            setTimeout(() => steps[currentStep].handler(), 100);
                        });
                        return;
                    } else {
                        clearTimeoutHandle();
                        reject(new Error('STARTTLS upgrade failed'));
                        return;
                    }
                }

                // Handle TLS connection (skip STARTTLS steps)
                if (isSecure && currentStepInfo.name === 'starttls') {
                    currentStep += 2; // Skip starttls and ehlo2
                } else if (isSecure && currentStepInfo.name === 'ehlo2') {
                    currentStep++; // Skip ehlo2
                } else {
                    currentStep++;
                }

                // Proceed to next step
                if (currentStep < steps.length && (code >= 200 && code < 400)) {
                    setTimeout(() => {
                        try {
                            steps[currentStep].handler();
                        } catch (err) {
                            clearTimeoutHandle();
                            reject(err);
                        }
                    }, 100);
                } else if (currentStep >= steps.length) {
                    clearTimeoutHandle();
                    socketRef.current.end();
                    resolve();
                }
            };

            // Choose connection method
            if (this.secure || this.port === 465) {
                connectWithTls();
            } else {
                connectPlain();
            }

            this.handleResponse = handleResponse;
        });
    }

    setupSocketHandlers(socket, resolve, reject, clearTimeoutFn) {
        let buffer = '';

        socket.on('data', (data) => {
            buffer += data.toString();
            
            if (buffer.includes('\r\n')) {
                const lines = buffer.split('\r\n');
                buffer = lines.pop();
                
                for (const line of lines) {
                    if (line.trim()) {
                        this.handleResponse(line);
                    }
                }
            }
        });

        socket.on('error', (err) => {
            clearTimeoutFn();
            reject(new Error(`SMTP connection error: ${err.message}`));
        });

        socket.on('close', () => {
            clearTimeoutFn();
        });

        socket.on('timeout', () => {
            socket.destroy();
            reject(new Error('SMTP connection timeout'));
        });
    }

    upgradeToTls(plainSocket, resolve, reject, setupTimeout, clearTimeoutFn, callback) {
        clearTimeoutFn();
        
        const tlsSocket = tls.connect({
            socket: plainSocket,
            host: this.host,
            rejectUnauthorized: false
        }, () => {
            console.log('STARTTLS upgrade successful');
            setupTimeout(tlsSocket);
            
            // Setup new socket handlers for TLS socket
            this.setupSocketHandlers(tlsSocket, resolve, reject, clearTimeoutFn);
            
            // Call callback with new TLS socket
            callback(tlsSocket);
        });

        tlsSocket.on('error', (err) => {
            clearTimeoutFn();
            reject(new Error(`TLS upgrade error: ${err.message}`));
        });
    }

    waitForGreeting() {
        return true;
    }

    handleStartTls(socket) {
        this.sendCommand(socket, 'STARTTLS');
        return true;
    }

    sendCommand(socket, command) {
        console.log(`SMTP Command: ${command}`);
        socket.write(command + '\r\n');
        return true;
    }

    sendEmailContent(socket, emailData) {
        const emailContent = this.formatEmail(emailData);
        console.log('SMTP Command: [EMAIL CONTENT]');
        socket.write(emailContent + '\r\n.\r\n');
        return true;
    }

    formatEmail(emailData) {
        const date = new Date().toUTCString();
        return `From: ${this.from}
To: ${emailData.to}
Subject: ${emailData.subject}
Date: ${date}
Content-Type: text/plain; charset=UTF-8

${emailData.text}`;
    }
}

module.exports = SmtpClient;
