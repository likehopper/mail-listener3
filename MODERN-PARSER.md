# Maintained MIME parser migration

This fork uses mailparser 3.9.40 through mail-parser.js and requires Node 20 or
newer. This is an explicit 0.1.0 compatibility change, not an update for old Node
runtimes. Original author and license notices remain intact.

The listener still emits mail objects through its mail event. Address headers
are normalized to the legacy arrays, and attachments retain generatedFileName,
fileName, contentId and buffered content (or stream in streamAttachments mode).
HTML-only mail does not gain generated plain text, and cid links remain intact.
Generic binary MIME types use filename-based MIME inference. Generated names
are basenames and duplicate names within one message receive distinct suffixes.
Existing optional unique file storage and UTF-8 filename limits still apply.

This is not full emulation of every undocumented field from mailparser 0.4.
headers is a plain object whose values are the modern parser's parsed header
values; consumers relying on old raw header value shapes must adapt explicitly.
Legacy parser-specific constructor options are not guaranteed to retain their
old meaning. Streamed attachments still require consumers to drain their stream.
The wrapper releases the modern parser attachment after the stream ends.
Returned HTML is untrusted and is not sanitized for direct browser injection.

Validation commands in an isolated checkout with dependencies installed:

```sh
node tests/mail-parser.test.js
node tests/attachments.test.js
node tests/reconnection.test.js
node tests/reconnection-socket.test.js
```

The MIME tests cover Unicode headers, missing sender, HTML-only mail, duplicate
binary attachments, legacy streaming and inline CID images. The Jeedom plugin's
real attachment-storage regression also passes against this adapter, including
long accented and emoji filenames. Provider IMAP and downstream plugin migration
remain separate acceptance steps.

The Jeedom plugin must update its pinned library, installer compatibility checks
and parser-specific tests in a separate integration PR before using this version.
In particular, legacy parser source patches must not be applied to the modern
parser. The existing Jeedom utf7/semver override must be preserved. A standalone
library install still reports the older IMAP/utf7/semver advisory chain unless
the consumer applies that existing override; the modern MIME parser does not fix
that separate chain by itself.
