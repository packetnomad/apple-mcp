import { run } from "@jxa/run";
import { runAppleScript } from "run-applescript";

async function checkMailAccess(): Promise<boolean> {
  try {
    // First check if Mail is running
    const isRunning = await runAppleScript(`
tell application "System Events"
    return application process "Mail" exists
end tell`);

    if (isRunning !== "true") {
      console.log("Mail app is not running, attempting to launch...");
      try {
        await runAppleScript(`
tell application "Mail" to activate
delay 2`);
      } catch (activateError) {
        console.error("Error activating Mail app:", activateError);
        throw new Error(
          "Could not activate Mail app. Please start it manually.",
        );
      }
    }

    // Try to get the count of mailboxes as a simple test
    try {
      await runAppleScript(`
tell application "Mail"
    count every mailbox
end tell`);
      return true;
    } catch (mailboxError) {
      console.error("Error accessing mailboxes:", mailboxError);

      // Try an alternative check
      try {
        const mailVersion = await runAppleScript(`
tell application "Mail"
    return its version
end tell`);
        console.log("Mail version:", mailVersion);
        return true;
      } catch (versionError) {
        console.error("Error getting Mail version:", versionError);
        throw new Error(
          "Mail app is running but cannot access mailboxes. Please check permissions and configuration.",
        );
      }
    }
  } catch (error) {
    console.error("Mail access check failed:", error);
    throw new Error(
      `Cannot access Mail app. Please make sure Mail is running and properly configured. Error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

interface EmailMessage {
  subject: string;
  sender: string;
  dateSent: string;
  content: string;
  isRead: boolean;
  mailbox: string;
}

async function getUnreadMails(limit: number = 10): Promise<EmailMessage[]> {
  try {
    if (!(await checkMailAccess())) {
      return [];
    }

    // First, try with AppleScript which might be more reliable for this case
    try {
      const script = `
tell application "Mail"
    set allMailboxes to every mailbox
    set resultList to {}

    -- First find account mailboxes with unread messages
    repeat with m in allMailboxes
        try
            set unreadMessages to (messages of m whose read status is false)
            if (count of unreadMessages) > 0 then
                set msgLimit to ${limit}
                if (count of unreadMessages) < msgLimit then
                    set msgLimit to (count of unreadMessages)
                end if

                repeat with i from 1 to msgLimit
                    try
                        set currentMsg to item i of unreadMessages
                        -- Basic email info
                        set msgData to {subject:(subject of currentMsg), sender:(sender of currentMsg), ¬
                                        date:(date sent of currentMsg) as string, mailbox:(name of m)}

                        -- Try to get content if possible
                        try
                            set msgContent to content of currentMsg
                            if length of msgContent > 500 then
                                set msgContent to (text 1 thru 500 of msgContent) & "..."
                            end if
                            set msgData to msgData & {content:msgContent}
                        on error
                            set msgData to msgData & {content:"[Content not available]"}
                        end try

                        set end of resultList to msgData
                    on error
                        -- Skip problematic messages
                    end try
                end repeat

                if (count of resultList) ≥ ${limit} then exit repeat
            end if
        on error
            -- Skip problematic mailboxes
        end try
    end repeat

    return resultList
end tell`;

      const asResult = await runAppleScript(script);

      // If we got results, parse them
      if (asResult && asResult.toString().trim().length > 0) {
        try {
          // Try to parse as JSON if the result looks like JSON
          if (asResult.startsWith("{") || asResult.startsWith("[")) {
            const parsedResults = JSON.parse(asResult);
            if (Array.isArray(parsedResults) && parsedResults.length > 0) {
              return parsedResults.map((msg) => ({
                subject: msg.subject || "No subject",
                sender: msg.sender || "Unknown sender",
                dateSent: msg.date || new Date().toString(),
                content: msg.content || "[Content not available]",
                isRead: false, // These are all unread by definition
                mailbox: msg.mailbox || "Unknown mailbox",
              }));
            }
          }

          // If it's not in JSON format, try to parse the plist/record format
          const parsedEmails: EmailMessage[] = [];

          // Very simple parsing for the record format that AppleScript might return
          // This is a best-effort attempt and might not be perfect
          const matches = asResult.match(/\{([^}]+)\}/g);
          if (matches && matches.length > 0) {
            matches.forEach((match) => {
              try {
                // Parse key-value pairs
                const props = match.substring(1, match.length - 1).split(",");
                const emailData: any = {};

                props.forEach((prop) => {
                  const parts = prop.split(":");
                  if (parts.length >= 2) {
                    const key = parts[0].trim();
                    const value = parts.slice(1).join(":").trim();
                    emailData[key] = value;
                  }
                });

                if (emailData.subject || emailData.sender) {
                  parsedEmails.push({
                    subject: emailData.subject || "No subject",
                    sender: emailData.sender || "Unknown sender",
                    dateSent: emailData.date || new Date().toString(),
                    content: emailData.content || "[Content not available]",
                    isRead: false,
                    mailbox: emailData.mailbox || "Unknown mailbox",
                  });
                }
              } catch (parseError) {
                console.log("Error parsing email match:", parseError);
              }
            });
          }

          if (parsedEmails.length > 0) {
            return parsedEmails;
          }
        } catch (parseError) {
          console.log("Error parsing AppleScript result:", parseError);
          // If parsing failed, continue to the JXA approach
        }
      }

      // If the raw result contains useful info but parsing failed
      if (
        asResult &&
        asResult.includes("subject") &&
        asResult.includes("sender")
      ) {
        console.log("Returning raw AppleScript result for debugging");
        return [
          {
            subject: "Raw AppleScript Output",
            sender: "Mail System",
            dateSent: new Date().toString(),
            content: `Could not parse Mail data properly. Raw output: ${asResult}`,
            isRead: false,
            mailbox: "Debug",
          },
        ];
      }
    } catch (asError) {
      // Continue to JXA approach as fallback
    }

    console.log("Trying JXA approach for unread emails...");
    // Check Mail accounts as a different approach
    const accounts = await runAppleScript(`
tell application "Mail"
    set accts to {}
    repeat with a in accounts
        set end of accts to name of a
    end repeat
    return accts
end tell`);
    console.log("Available accounts:", accounts);

    // Try using direct AppleScript to check for unread messages across all accounts
    const unreadInfo = await runAppleScript(`
tell application "Mail"
    set unreadInfo to {}
    repeat with m in every mailbox
        try
            set unreadCount to count (messages of m whose read status is false)
            if unreadCount > 0 then
                set end of unreadInfo to {name of m, unreadCount}
            end if
        on error
            -- Skip error mailboxes
        end try
    end repeat
    return unreadInfo
end tell`);
    console.log("Mailboxes with unread messages:", unreadInfo);

    // Fallback to JXA approach
    const unreadMails: EmailMessage[] = await run((limit: number) => {
      const Mail = Application("Mail");
      const results = [];

      try {
        // Get all accounts first
        const accounts = Mail.accounts();
        console.log(`Found ${accounts.length} accounts`);

        // Go through all accounts to find mailboxes
        for (const account of accounts) {
          try {
            const accountName = account.name();
            console.log(`Processing account: ${accountName}`);

            // Try to get mailboxes for this account
            try {
              const accountMailboxes = account.mailboxes();
              console.log(
                `Account ${accountName} has ${accountMailboxes.length} mailboxes`,
              );

              // Process each mailbox
              for (const mailbox of accountMailboxes) {
                try {
                  const boxName = mailbox.name();
                  console.log(`Checking ${boxName} in ${accountName}`);

                  // Try to get unread messages
                  let unreadMessages;
                  try {
                    unreadMessages = mailbox.messages.whose({
                      readStatus: false,
                    })();
                    console.log(
                      `Found ${unreadMessages.length} unread in ${boxName}`,
                    );

                    // Process unread messages
                    const count = Math.min(
                      unreadMessages.length,
                      limit - results.length,
                    );
                    for (let i = 0; i < count; i++) {
                      try {
                        const msg = unreadMessages[i];
                        results.push({
                          subject: msg.subject(),
                          sender: msg.sender(),
                          dateSent: msg.dateSent().toString(),
                          content: msg.content()
                            ? msg.content().substring(0, 500)
                            : "[No content]",
                          isRead: false,
                          mailbox: `${accountName} - ${boxName}`,
                        });
                      } catch (msgError) {
                        console.log(`Error with message: ${msgError}`);
                      }
                    }
                  } catch (unreadError) {
                    console.log(
                      `Error getting unread for ${boxName}: ${unreadError}`,
                    );
                  }
                } catch (boxError) {
                  console.log(`Error with mailbox: ${boxError}`);
                }

                // If we have enough messages, stop
                if (results.length >= limit) {
                  break;
                }
              }
            } catch (mbError) {
              console.log(
                `Error getting mailboxes for ${accountName}: ${mbError}`,
              );
            }

            // If we have enough messages, stop
            if (results.length >= limit) {
              break;
            }
          } catch (accError) {
            console.log(`Error with account: ${accError}`);
          }
        }
      } catch (error) {
        console.log(`General error: ${error}`);
      }

      console.log(`Returning ${results.length} unread messages`);
      return results;
    }, limit);

    return unreadMails;
  } catch (error) {
    console.error("Error in getUnreadMails:", error);
    throw new Error(
      `Error accessing mail: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function searchMails(
  searchTerm: string,
  limit: number = 10,
): Promise<EmailMessage[]> {
  try {
    if (!(await checkMailAccess())) {
      return [];
    }

    // Ensure Mail app is running
    await runAppleScript(`
if application "Mail" is not running then
    tell application "Mail" to activate
    delay 2
end if`);

    // First try the AppleScript approach which might be more reliable
    try {
      const script = `
tell application "Mail"
    set searchString to "${searchTerm.replace(/"/g, '\\"')}"
    set foundMsgs to {}
    set allBoxes to every mailbox

    repeat with currentBox in allBoxes
        try
            set boxMsgs to (messages of currentBox whose (subject contains searchString) or (content contains searchString))
            set foundMsgs to foundMsgs & boxMsgs
            if (count of foundMsgs) ≥ ${limit} then exit repeat
        on error
            -- Skip mailboxes that error out
        end try
    end repeat

    set resultList to {}
    set msgCount to (count of foundMsgs)
    if msgCount > ${limit} then set msgCount to ${limit}

    repeat with i from 1 to msgCount
        try
            set currentMsg to item i of foundMsgs
            set msgInfo to {subject:subject of currentMsg, sender:sender of currentMsg, ¬
                            date:(date sent of currentMsg) as string, isRead:read status of currentMsg, ¬
                            boxName:name of (mailbox of currentMsg)}
            set end of resultList to msgInfo
        on error
            -- Skip messages that error out
        end try
    end repeat

    return resultList
end tell`;

      const asResult = await runAppleScript(script);

      // If we got results, parse them
      if (asResult && asResult.length > 0) {
        try {
          const parsedResults = JSON.parse(asResult);
          if (Array.isArray(parsedResults) && parsedResults.length > 0) {
            return parsedResults.map((msg) => ({
              subject: msg.subject || "No subject",
              sender: msg.sender || "Unknown sender",
              dateSent: msg.date || new Date().toString(),
              content: "[Content not available through AppleScript method]",
              isRead: msg.isRead || false,
              mailbox: msg.boxName || "Unknown mailbox",
            }));
          }
        } catch (parseError) {
          console.log("Error parsing AppleScript result:", parseError);
          // Continue to JXA approach if parsing fails
        }
      }
    } catch (asError) {
      // Continue to JXA approach
    }

    // JXA approach as fallback
    const searchResults: EmailMessage[] = await run(
      (searchTerm: string, limit: number) => {
        const Mail = Application("Mail");
        const results = [];

        console.log(`Searching for "${searchTerm}" in mailboxes...`);

        // Search in the most common mailboxes
        try {
          const mailboxes = Mail.mailboxes();
          console.log(`Found ${mailboxes.length} mailboxes to search`);

          for (const mailbox of mailboxes) {
            try {
              console.log(`Searching in mailbox: ${mailbox.name()}`);

              // Try to find messages with the search term in subject or content
              let messages;
              try {
                messages = mailbox.messages.whose({
                  _or: [
                    { subject: { _contains: searchTerm } },
                    { content: { _contains: searchTerm } },
                  ],
                })();

                console.log(
                  `Found ${messages.length} matching messages in ${mailbox.name()}`,
                );
              } catch (queryError) {
                console.log(
                  `Error querying messages in ${mailbox.name()}:`,
                  queryError,
                );
                continue;
              }

              // Take only the most recent messages up to the limit
              const count = Math.min(messages.length, limit);

              for (let i = 0; i < count; i++) {
                try {
                  const msg = messages[i];
                  results.push({
                    subject: msg.subject(),
                    sender: msg.sender(),
                    dateSent: msg.dateSent().toString(),
                    content: msg.content()
                      ? msg.content().substring(0, 500)
                      : "[No content]", // Limit content length
                    isRead: msg.readStatus(),
                    mailbox: mailbox.name(),
                  });
                } catch (msgError) {
                  console.log("Error processing message:", msgError);
                }
              }

              if (results.length >= limit) {
                break;
              }
            } catch (boxError) {
              console.log(`Error with mailbox ${mailbox.name()}:`, boxError);
            }
          }
        } catch (mbError) {
          console.log("Error getting mailboxes:", mbError);
        }

        console.log(`Returning ${results.length} search results`);
        return results.slice(0, limit);
      },
      searchTerm,
      limit,
    );

    return searchResults;
  } catch (error) {
    console.error("Error in searchMails:", error);
    throw new Error(
      `Error searching mail: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function sendMail(
  to: string,
  subject: string,
  body: string,
  cc?: string,
  bcc?: string,
): Promise<string | undefined> {
  try {
    if (!(await checkMailAccess())) {
      throw new Error("Could not access Mail app");
    }

    // Ensure Mail app is running
    await runAppleScript(`
if application "Mail" is not running then
    tell application "Mail" to activate
    delay 2
end if`);

    // Escape special characters in strings for AppleScript
    const escapedTo = to.replace(/"/g, '\\"');
    const escapedSubject = subject.replace(/"/g, '\\"');
    const escapedBody = body.replace(/"/g, '\\"');
    const escapedCc = cc ? cc.replace(/"/g, '\\"') : "";
    const escapedBcc = bcc ? bcc.replace(/"/g, '\\"') : "";

    let script = `
tell application "Mail"
    set newMessage to make new outgoing message with properties {subject:"${escapedSubject}", content:"${escapedBody}", visible:true}
    tell newMessage
        make new to recipient with properties {address:"${escapedTo}"}
`;

    if (cc) {
      script += `        make new cc recipient with properties {address:"${escapedCc}"}\n`;
    }

    if (bcc) {
      script += `        make new bcc recipient with properties {address:"${escapedBcc}"}\n`;
    }

    script += `    end tell
    send newMessage
    return "success"
end tell
`;

    try {
      const result = await runAppleScript(script);
      if (result === "success") {
        return `Email sent to ${to} with subject "${subject}"`;
      } else {
      }
    } catch (asError) {
      console.error("Error in AppleScript send:", asError);

      const jxaResult: string = await run(
        (to, subject, body, cc, bcc) => {
          try {
            const Mail = Application("Mail");

            const msg = Mail.OutgoingMessage().make();
            msg.subject = subject;
            msg.content = body;
            msg.visible = true;

            // Add recipients
            const toRecipient = Mail.ToRecipient().make();
            toRecipient.address = to;
            msg.toRecipients.push(toRecipient);

            if (cc) {
              const ccRecipient = Mail.CcRecipient().make();
              ccRecipient.address = cc;
              msg.ccRecipients.push(ccRecipient);
            }

            if (bcc) {
              const bccRecipient = Mail.BccRecipient().make();
              bccRecipient.address = bcc;
              msg.bccRecipients.push(bccRecipient);
            }

            msg.send();
            return "JXA send completed";
          } catch (error) {
            return `JXA error: ${error}`;
          }
        },
        to,
        subject,
        body,
        cc,
        bcc,
      );

      if (jxaResult.startsWith("JXA error:")) {
        throw new Error(jxaResult);
      }

      return `Email sent to ${to} with subject "${subject}"`;
    }
  } catch (error) {
    console.error("Error in sendMail:", error);
    throw new Error(
      `Error sending mail: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function getMailboxes(): Promise<string[]> {
  try {
    if (!(await checkMailAccess())) {
      return [];
    }

    // Ensure Mail app is running
    await runAppleScript(`
if application "Mail" is not running then
    tell application "Mail" to activate
    delay 2
end if`);

    const mailboxes: string[] = await run(() => {
      const Mail = Application("Mail");

      // Try to get mailboxes
      try {
        const mailboxes = Mail.mailboxes();

        if (!mailboxes || mailboxes.length === 0) {
          console.log("No mailboxes found directly");

          // Try alternative approach
          try {
            const result = Mail.execute({
              withObjectModel: "Mail Suite",
              withCommand: "get name of every mailbox",
            });

            if (result && result.length > 0) {
              console.log("Found mailboxes via execute method");
              return result;
            }
          } catch (execError) {
            console.log("Error with execute method:", execError);
          }

          return [];
        }

        return mailboxes.map((box: any) => {
          try {
            return box.name();
          } catch (nameError) {
            console.log("Error getting mailbox name:", nameError);
            return "Unknown mailbox";
          }
        });
      } catch (error) {
        console.log("Error accessing mailboxes:", error);
        return [];
      }
    });

    console.log("Retrieved mailboxes:", mailboxes);
    return mailboxes;
  } catch (error) {
    console.error("Error in getMailboxes:", error);
    throw new Error(
      `Error getting mailboxes: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function getAccounts(): Promise<string[]> {
  try {
    if (!(await checkMailAccess())) {
      return [];
    }

    const accounts = await runAppleScript(`
tell application "Mail"
    set acctNames to {}
    repeat with a in accounts
        set end of acctNames to name of a
    end repeat
    return acctNames
end tell`);

    return accounts ? accounts.split(", ") : [];
  } catch (error) {
    console.error("Error getting accounts:", error);
    throw new Error(
      `Error getting mail accounts: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function getMailboxesForAccount(accountName: string): Promise<string[]> {
  try {
    if (!(await checkMailAccess())) {
      return [];
    }

    const mailboxes = await runAppleScript(`
tell application "Mail"
    set boxNames to {}
    try
        set targetAccount to first account whose name is "${accountName.replace(/"/g, '\\"')}"
        set acctMailboxes to every mailbox of targetAccount
        repeat with mb in acctMailboxes
            set end of boxNames to name of mb
        end repeat
    on error errMsg
        return "Error: " & errMsg
    end try
    return boxNames
end tell`);

    if (mailboxes && mailboxes.startsWith("Error:")) {
      console.error(mailboxes);
      return [];
    }

    return mailboxes ? mailboxes.split(", ") : [];
  } catch (error) {
    console.error("Error getting mailboxes for account:", error);
    throw new Error(
      `Error getting mailboxes for account ${accountName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export default {
  getUnreadMails,
  searchMails,
  sendMail,
  getMailboxes,
  getAccounts,
  getMailboxesForAccount,
};
