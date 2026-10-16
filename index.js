var Imap = require('imap'),
    util = require('util'),
    EventEmitter = require('events').EventEmitter,
    MailParser = require("mailparser").MailParser,
    fs = require("fs"),
    path = require('path'),
    async = require('async');

module.exports = MailListener;

function MailListener(options) {
    // Reconnection is opt-in to preserve existing consumers' lifecycle behavior.
    this.reconnect = options.reconnect === true;
    this.reconnectDelay = options.reconnectDelay === undefined ? 1000 : options.reconnectDelay;
    this.reconnectMaxDelay = options.reconnectMaxDelay === undefined ? 30000 : options.reconnectMaxDelay;
    if (typeof this.reconnectDelay !== 'number' || !isFinite(this.reconnectDelay) || this.reconnectDelay <= 0 ||
        typeof this.reconnectMaxDelay !== 'number' || !isFinite(this.reconnectMaxDelay) ||
        this.reconnectMaxDelay < this.reconnectDelay || this.reconnectMaxDelay > 2147483647) {
        throw new RangeError('Invalid reconnection delay range');
    }
    this._started = false;
    this._reconnectTimer = null;
    this._nextReconnectDelay = this.reconnectDelay;
    this.markSeen = !!options.markSeen;
    this.mailbox = options.mailbox || "INBOX";
    if ('string' === typeof options.searchFilter) {
        this.searchFilter = [options.searchFilter];
    } else {
        this.searchFilter = options.searchFilter || ["UNSEEN"];
    }
    this.fetchUnreadOnStart = !!options.fetchUnreadOnStart;
    this.mailParserOptions = options.mailParserOptions || {};
    if (options.attachments && options.attachmentOptions && options.attachmentOptions.stream) {
        this.mailParserOptions.streamAttachments = true;
    }
    this.attachmentOptions = options.attachmentOptions || {};
    this.attachments = options.attachments || false;
    this.attachmentOptions.directory = (this.attachmentOptions.directory ? this.attachmentOptions.directory : '');
    this.imap = new Imap({
        xoauth2: options.xoauth2,
        user: options.username,
        password: options.password,
        host: options.host,
        port: options.port,
        tls: options.tls,
        tlsOptions: options.tlsOptions || {}
    });

    this.imap.on('ready', imapReady.bind(this));
    this.imap.on('close', imapClose.bind(this));
    this.imap.on('mail', imapMail.bind(this));
    this.imap.on('error', imapError.bind(this));
}

util.inherits(MailListener, EventEmitter);

MailListener.prototype.start = function () {
    if (this._started) return;
    this._started = true;
    this._nextReconnectDelay = this.reconnectDelay;
    this.imap.connect();
};

MailListener.prototype.stop = function () {
    this._started = false;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this.imap.end();
};

function imapReady() {
    var self = this;
    if (!this._started) return;
    this.imap.openBox(this.mailbox, false, function (err, mailbox) {
        if (!self._started) return;
        if (err) {
            self.emit('error', err);
            if (self.reconnect && self._started) self.imap.end();
        } else {
            self._nextReconnectDelay = self.reconnectDelay;
            self.emit('server:connected');
            if (self._started && self.fetchUnreadOnStart) {
                parseUnread.call(self);
            }
        }
    });
}

function imapClose() {
    if (!this.reconnect) this._started = false;
    this.emit('server:disconnected');
    if (!this.reconnect || !this._started || this._reconnectTimer !== null) return;
    var self = this;
    var delay = this._nextReconnectDelay;
    this._nextReconnectDelay = Math.min(delay * 2, this.reconnectMaxDelay);
    this._reconnectTimer = setTimeout(function () {
        self._reconnectTimer = null;
        if (self._started) self.imap.connect();
    }, delay);
    this.emit('server:reconnecting', delay);
}

function imapError(err) {
    this.emit('error', err);
}

function imapMail() {
    if (this._started) parseUnread.call(this);
}

function parseUnread() {
    var self = this;
    this.imap.search(self.searchFilter, function (err, results) {
        if (err) {
            self.emit('error', err);
        } else if (results.length > 0) {
            var remaining = results.length;
            async.each(results, function (result, callback) {
                var f = self.imap.fetch(result, {
                    bodies: '',
                    markSeen: self.markSeen
                });
                f.on('message', function (msg, seqno) {
                    var parser = new MailParser(self.mailParserOptions);
                    var attributes = null;

                    parser.on("end", function (mail) {
                        if (!self.mailParserOptions.streamAttachments && mail.attachments && self.attachments) {
                            async.each(mail.attachments, function (attachment, callback) {
                                fs.writeFile(self.attachmentOptions.directory + attachment.generatedFileName, attachment.content, function (err) {
                                    if (err) {
                                        self.emit('error', err);
                                        callback();
                                    } else {
                                        attachment.path = path.resolve(self.attachmentOptions.directory + attachment.generatedFileName);
                                        self.emit('attachment', attachment, mail);
                                        callback();
                                    }
                                });
                            }, function (err) {
                                self.emit('mail', mail, seqno, attributes);
                                callback()
                            });
                        } else {
                            self.emit('mail', mail, seqno, attributes);
                        }
                        remaining = remaining - 1;
                        if (remaining == 0) {
                            self.emit('done');
                        }
                    });
                    parser.on("attachment", function (attachment) {
                        var args = Array.prototype.slice.call(arguments);
                        args.unshift('attachment');
                        self.emit.apply(self, args);
                    });
                    msg.on('body', function (stream, info) {
                        stream.pipe(parser);
                    });
                    msg.on('attributes', function (attrs) {
                        attributes = attrs;
                    });
                });
                f.once('error', function (err) {
                    self.emit('error', err);
                });
            }, function (err) {
                if (err) {
                    self.emit('error', err);
                }
            });
        } else {
            self.emit('done');
        }
    });
}