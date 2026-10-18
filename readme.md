# Overview

Mail-listener2 library for node.js. Get notification when new email arrived to inbox. Uses IMAP protocol.

We are using these libraries: [node-imap](https://github.com/mscdex/node-imap), [mailparser](https://github.com/andris9/mailparser).

Heavily inspired by [mail-listener](https://github.com/circuithub/mail-listener).

## Use

Install

`npm install mail-listener2`


JavaScript Code:


```javascript

var MailListener = require("mail-listener2");

var mailListener = new MailListener({
  username: "imap-username",
  password: "imap-password",
  host: "imap-host",
  port: 993, // imap port
  tls: true,
  tlsOptions: { rejectUnauthorized: false },
  mailbox: "INBOX", // mailbox to monitor
  searchFilter: ["UNSEEN", "FLAGGED"], // the search filter being used after an IDLE notification has been retrieved
  markSeen: true, // all fetched email willbe marked as seen and not fetched next time
  fetchUnreadOnStart: true, // use it only if you want to get all unread email on lib start. Default is `false`,
  mailParserOptions: {streamAttachments: true}, // options to be passed to mailParser lib.
  attachments: true, // download attachments as they are encountered to the project directory
  attachmentOptions: { directory: "attachments/" } // specify a download directory for attachments
});

mailListener.start(); // start listening

// stop listening
//mailListener.stop();

mailListener.on("server:connected", function(){
  console.log("imapConnected");
});

mailListener.on("server:disconnected", function(){
  console.log("imapDisconnected");
});

mailListener.on("error", function(err){
  console.log(err);
});

mailListener.on("mail", function(mail, seqno, attributes){
  // do something with mail object including attachments
  console.log("emailParsed", mail);
  // mail processing code goes here
});

mailListener.on("attachment", function(attachment){
  console.log(attachment.path);
});

mailListener.on("done", function(attachment){
  console.log("No more messages");
});

// it's possible to access imap object from node-imap library for performing additional actions. E.x.
mailListener.imap.move(:msguids, :mailboxes, function(){})

```

That's easy!

## Attachments
Attachments can be streamed or buffered. This feature is based on how [mailparser](https://github.com/andris9/mailparser#attachments) handles attachments. 
Setting `attachments: true` will download attachments as buffer objects by default to the project directory.
A specific download directory may be specified by setting `attachmentOptions: { directory: "attachments/"}`. 
Attachments may also be streamed using `attachmentOptions: { stream: "true"}`. The `"attachment"` event will be fired every time an attachment is encountered.
Refer to the [mailparser docs](https://github.com/andris9/mailparser#attachment-streaming) for specifics on how to stream attachments.


## License

MIT

## Optional reconnection

Automatic reconnection is disabled by default. Set `reconnect: true` to retry
closed IMAP sessions while the listener is started. `reconnectDelay` defaults to
1000 milliseconds; `reconnectMaxDelay` defaults to 30000 milliseconds. Consecutive
failures double the delay up to the maximum. Opening the mailbox successfully
resets the delay. Authentication failures are also retried with this backoff.

`server:reconnecting` emits the delay in milliseconds before each scheduled
attempt. Existing error and disconnected events are still emitted. Register an
`error` handler as usual. `stop()` cancels pending retries and prevents automatic
reconnection; call `start()` explicitly to resume. This does not add durable mail
delivery or change the markSeen policy.

Tests (Node.js 22, after installing dependencies):

```sh
node tests/reconnection.test.js
node tests/reconnection-socket.test.js
```

The socket test uses an ephemeral loopback IMAP server and synthetic credentials;
it does not access a real mailbox.


### Unique attachment filenames

For buffered attachment downloads, opt into collision-safe storage with
`attachmentOptions: { directory: "attachments/", uniqueFilenames: true }`.
Each saved file receives a random 128-bit prefix followed by its generated base
name. The download directory must already exist. `attachment.path` identifies
the actual saved file, while `generatedFileName` retains the original parser
name. Exclusive creation refuses a collision instead of overwriting a file.
Write or random-generation failures emit an error and leave the attachment
without a successful path; consumers must handle incomplete downloads.

This option is off by default to preserve existing naming behavior. It does not
change streamed attachments or add retention/purge behavior. Retrying a message
can create another distinct file; callers requiring deduplication need their
own persistent message identity handling.

Unique stored filenames are capped at 255 UTF-8 bytes including the random prefix.
Long stems are shortened without splitting Unicode characters; the original
`generatedFileName` metadata is retained. Extensions are preserved when they fit
within the available suffix budget; an oversized extension is truncated as part
of the complete name. Short names, legacy naming and streaming are unchanged.
