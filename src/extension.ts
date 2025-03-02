import * as vscode from "vscode";
import * as path from "path";
import { exec } from "child_process";
import { platform } from "os";

export function activate(context: vscode.ExtensionContext) {
  console.log("Cursor Chat Beep extension is now active");

  // Create an output channel for logging
  const outputChannel = vscode.window.createOutputChannel("Cursor Chat Beep");

  // Show output channel for easier debugging during development
  outputChannel.show();
  
  outputChannel.appendLine("Cursor Chat Beep started");
  outputChannel.appendLine(`Cursor/VS Code version: ${vscode.version}`);

  // Helper function to check if document is a Cursor chat/composer
  function isCursorChatOrComposer(doc: vscode.TextDocument): boolean {
    // Ignore output panels to prevent feedback loops
    const scheme = doc.uri.scheme;
    const uri = doc.uri.toString();
    const languageId = doc.languageId;
    
    if (scheme === "output") {
      return false;
    }
    
    // More aggressive logging for debugging
    outputChannel.appendLine(`\nChecking document: ${uri}`);
    outputChannel.appendLine(`Scheme: ${scheme}`);
    outputChannel.appendLine(`Language ID: ${languageId}`);
    outputChannel.appendLine(`Text length: ${doc.getText().length}`);
    
    // Get a sample of the text for analysis
    const textSample = doc.getText().substring(0, Math.min(500, doc.getText().length));
    outputChannel.appendLine(`Text sample: ${textSample}`);
    
    // Check specifically for Cursor's chat patterns
    const containsCursorChatPatterns = 
      // Cursor's specific patterns
      textSample.includes("Human:") ||
      textSample.includes("Assistant:") ||
      textSample.includes("You are a powerful agentic AI coding assistant") ||
      textSample.includes("You are pair programming with a USER") ||
      (textSample.includes("user") && textSample.includes("query")) ||
      textSample.includes("<") ||
      textSample.includes("<function_results>");
      
    if (containsCursorChatPatterns) {
      outputChannel.appendLine(`- Contains specific Cursor chat patterns: true`);
      return true;
    }
    
    // SUPER AGGRESSIVE DETECTION - Include any document that could be related to chat
    const isChatRelated = 
      // Scheme-based detection
      scheme === "composer-code-block-anysphere" || 
      scheme === "cursor-composer-code-block" ||
      scheme === "composer-code-block" ||
      scheme.includes("composer") ||
      scheme.includes("chat") ||
      scheme === "untitled" || // New chat windows often start as untitled
      
      // URI-based detection
      uri.includes("cursor-chat") ||
      uri.includes("chat") ||
      uri.includes("cursor") ||
      uri.includes("ai") ||
      uri.includes("conversation") ||
      uri.includes("cursor.chat") ||
      uri.endsWith(".chat") ||
      
      // Language-based detection
      languageId === "markdown" ||
      languageId === "plaintext" ||
      languageId === "chat" ||
      
      // Content-based detection (more patterns)
      textSample.includes("chat") ||
      textSample.includes("cursor") ||
      textSample.includes("ai") ||
      textSample.includes("user:") ||
      textSample.toLowerCase().includes("what") ||
      textSample.toLowerCase().includes("how") ||
      
      // Fallback: detect any reasonable text input
      (doc.getText().trim().length > 0 && doc.getText().trim().length < 5000);
    
    outputChannel.appendLine(`Is chat related: ${isChatRelated}`);
    return isChatRelated;
  }

  // Helper function to get current configuration
  function getConfig() {
    const config = vscode.workspace.getConfiguration("cursorChatBeep");
    return {
      enabled: config.get<boolean>("enabled", true),
      delayMs: config.get<number>("delayMs", 3000),
      soundFile: config.get<string>("soundFile", "notification-bloop.wav"),
      volume: config.get<number>("volume", 0.5),
    };
  }

  // Create a debounced timer
  let debounceTimer: NodeJS.Timeout | undefined;
  
  // Add cooldown tracking to prevent multiple sounds
  let lastSoundTime = 0;
  const COOLDOWN_PERIOD = 15000; // 15 seconds cooldown
  let isInActiveSession = false;
  
  // Track complete responses
  let lastDocumentContent = "";
  let humanTurnDetected = false;
  let assistantTurnDetected = false;

  // Function to detect if the AI has completed its turn
  function isAIResponseComplete(text: string): boolean {
    // We don't necessarily need to see a human turn if assistant has clearly responded
    if (assistantTurnDetected) {
      // More aggressive patterns to detect a complete response
      const endsWithCompletionPattern = 
        // End of code block
        /```\s*$/.test(text) || 
        // End of list
        /\n\d+\.\s.+\s*$/.test(text) || 
        // End with a question
        /\?{1,3}\s*$/.test(text) || 
        // Period at end or other sentence ending punctuation
        /[.!?]\s*$/.test(text) ||
        // Ends with complete sentences
        /[.!?]\s+[A-Z].*[.!?]\s*$/.test(text) ||
        // Typical closing phrases
        /Let me know\s/.test(text) ||
        /Hope this helps\s/.test(text) ||
        /If you have any\s/.test(text) ||
        /Try it now\s/.test(text) ||
        
        // Cursor-specific patterns
        text.includes("Command completed") ||
        text.includes("function_results") ||
        text.includes("Let me know if") ||
        text.includes("Is there anything else") ||
        (text.length > 500); // Assume lengthy responses are complete (more aggressive)
      
      outputChannel.appendLine(`Checking completion patterns: ${endsWithCompletionPattern}`);
      return endsWithCompletionPattern;
    }
    
    // Fallback for when we don't have clear assistant turn
    return text.length > 200 && /[.!?]\s*$/.test(text);
  }
  
  // Check if the text contains patterns indicating a human or assistant turn
  function updateTurnDetection(text: string) {
    // Much more aggressive detection
    
    // Human turn patterns
    if (
      text.includes("Human:") || 
      text.includes("User:") ||
      text.includes("<user_query>") ||
      /<.*>/.test(text) ||  // Any XML-like tags (common in Cursor chats)
      text.toLowerCase().includes("?") ||  // Questions indicate user input
      text.split("\n").some(line => line.trim().length < 50 && line.trim().length > 5) // Short lines often indicate user input
    ) {
      humanTurnDetected = true;
      outputChannel.appendLine("Human turn detected");
    }
    
    // Assistant turn patterns
    if (
      text.includes("Assistant:") || 
      text.includes("Claude:") || 
      text.includes("AI:") ||
      text.includes("function_") ||
      text.includes("```") ||  // Code blocks indicate AI response
      text.length > 200 ||     // Lengthy responses are likely AI
      text.split("\n").length > 5 // Multi-line responses are likely AI
    ) {
      assistantTurnDetected = true;
      outputChannel.appendLine("Assistant turn detected");
    }
  }

  // Function to play sound using system audio
  async function playBoop() {
    const config = getConfig();
    if (!config.enabled) {
      outputChannel.appendLine("Beep is disabled in settings");
      return;
    }
    
    // Check if we're in cooldown period
    const now = Date.now();
    if (now - lastSoundTime < COOLDOWN_PERIOD) {
      outputChannel.appendLine(`Sound in cooldown period (${(now - lastSoundTime)/1000}s elapsed of ${COOLDOWN_PERIOD/1000}s cooldown)`);
      return;
    }
    
    // Update last sound time
    lastSoundTime = now;

    const soundFilePath = path.join(
      context.extensionPath,
      "media",
      config.soundFile
    );

    outputChannel.appendLine(`Attempting to play sound: ${soundFilePath}`);

    // Different commands for different operating systems
    let command = "";
    switch (platform()) {
      case "darwin": {
        // On macOS, afplay supports volume control (0 to 255)
        const macVolume = Math.floor(config.volume * 255);
        command = `afplay -v ${macVolume / 255} "${soundFilePath}"`;
        break;
      }
      case "win32":
        command = `powershell -c (New-Object Media.SoundPlayer '${soundFilePath}').PlaySync()`;
        break;
      default: {
        // Linux
        // On Linux, paplay supports volume (0 to 65536)
        const linuxVolume = Math.floor(config.volume * 65536);
        command = `paplay --volume=${linuxVolume} "${soundFilePath}" || aplay "${soundFilePath}"`;
        break;
      }
    }

    outputChannel.appendLine(`Executing command: ${command}`);

    return new Promise<void>((resolve, reject) => {
      exec(command, (error) => {
        if (error) {
          outputChannel.appendLine(`Error playing sound: ${error.message}`);
          reject(error);
        } else {
          outputChannel.appendLine("Sound played successfully");
          resolve();
        }
      });
    });
  }

  // Register command immediately to ensure it's available
  const testSoundCommand = vscode.commands.registerCommand(
    "cursorChatBeep.testSound", 
    async () => {
      outputChannel.appendLine("Manual sound test requested");
      await playBoop();
      outputChannel.appendLine("Manual sound test completed");
      vscode.window.showInformationMessage("Sound test completed! Did you hear the beep?");
    }
  );
  context.subscriptions.push(testSoundCommand);
  
  // Show notification that the test command is available
  vscode.window.showInformationMessage(
    "Cursor Chat Beep extension is active. Press Cmd+Shift+B (Mac) or Ctrl+Shift+B (Windows/Linux) to test the sound."
  );

  // Add a watching mechanism for the chat view
  let documentChangeCount = 0;
  const CHANGE_THRESHOLD = 5; // Play sound after this many document changes
  
  // Track when editors change - this might help catch the chat interface
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        const doc = editor.document;
        outputChannel.appendLine(`\n=== Editor Changed ===`);
        outputChannel.appendLine(`- URI: ${doc.uri.toString()}`);
        outputChannel.appendLine(`- Scheme: ${doc.uri.scheme}`);
        outputChannel.appendLine(`- Language: ${doc.languageId}`);
        
        // Get the document content
        const currentContent = doc.getText();
        
        // Update turn detection from content
        updateTurnDetection(currentContent);
        
        // Check if this might be chat-related
        const isChatDoc = isCursorChatOrComposer(doc);
        if (isChatDoc) {
          outputChannel.appendLine(`Chat interface detected - starting session tracking`);
          isInActiveSession = true;
          
          // Update turn detection based on content
          updateTurnDetection(currentContent);
          
          // Store current content
          lastDocumentContent = currentContent;
        } else if (isInActiveSession) {
          // If we switch away from a chat document while in a session
          outputChannel.appendLine(`Switched away from chat - checking if response was complete`);
          
          // Check if response was complete before we switched
          const responseComplete = isAIResponseComplete(lastDocumentContent);
          outputChannel.appendLine(`- Response appears complete: ${responseComplete}`);
          
          // Clear existing timer
          if (debounceTimer) {
            clearTimeout(debounceTimer);
          }
          
          // Only play sound if we detect a completed response
          if (responseComplete) {
            outputChannel.appendLine(`\n=== Chat Session Ended (switched documents with complete response) ===`);
            isInActiveSession = false;
            documentChangeCount = 0;
            humanTurnDetected = false;
            assistantTurnDetected = false;
            
            playBoop().catch((error) => {
              outputChannel.appendLine(`Failed to play sound: ${error.message}`);
            });
          } else {
            // Wait a bit in case user is just switching temporarily
            debounceTimer = setTimeout(() => {
              // Only play if still not active
              if (isInActiveSession) {
                outputChannel.appendLine(`\n=== Chat Session Ended (switched away for a while) ===`);
                isInActiveSession = false;
                documentChangeCount = 0;
                humanTurnDetected = false;
                assistantTurnDetected = false;
                
                playBoop().catch((error) => {
                  outputChannel.appendLine(`Failed to play sound: ${error.message}`);
                });
              }
            }, getConfig().delayMs * 3); // Longer delay when switching
          }
        }
      }
    })
  );
  
  // Monitor text document changes with a more aggressive approach
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const doc = event.document;
      
      // Skip output schemes to prevent feedback loops
      if (doc.uri.scheme === "output") {
        return;
      }
      
      // Get the current document content
      const currentContent = doc.getText();
      
      // Log all document changes for debugging
      outputChannel.appendLine(`\n=== Document Changed ===`);
      outputChannel.appendLine(`- URI: ${doc.uri.toString()}`);
      outputChannel.appendLine(`- Scheme: ${doc.uri.scheme}`);
      outputChannel.appendLine(`- Language: ${doc.languageId}`);
      outputChannel.appendLine(`- Change count: ${++documentChangeCount}`);
      
      // Check content after changes
      const textSample = currentContent.substring(0, Math.min(200, currentContent.length));
      outputChannel.appendLine(`- Text sample: ${textSample}`);
      
      // Check if changes contain typical chat patterns
      const containsChatPatterns = 
        event.contentChanges.some(change => 
          change.text.includes("Human:") || 
          change.text.includes("Assistant:") ||
          change.text.includes("user:") ||
          change.text.toLowerCase().includes("what") ||
          change.text.toLowerCase().includes("how") ||
          change.text.trim().length > 5
        );
      
      // Update turn detection based on current content
      updateTurnDetection(currentContent);
      
      // Check if the content significantly changed from last time
      const contentChanged = currentContent !== lastDocumentContent;
      lastDocumentContent = currentContent;
      
      outputChannel.appendLine(`- Contains chat patterns: ${containsChatPatterns}`);
      outputChannel.appendLine(`- Content changed: ${contentChanged}`);
      outputChannel.appendLine(`- Human turn detected: ${humanTurnDetected}`);
      outputChannel.appendLine(`- Assistant turn detected: ${assistantTurnDetected}`);
      
      // Check if this might be a chat-related document
      const isChatRelated = isCursorChatOrComposer(doc);
      
      // Detect the start of a chat session
      if ((isChatRelated || documentChangeCount >= CHANGE_THRESHOLD || containsChatPatterns) && !isInActiveSession) {
        isInActiveSession = true;
        humanTurnDetected = false;
        assistantTurnDetected = false;
        outputChannel.appendLine(`\n=== Chat Session Started ===`);
      }
      
      // If we're in an active chat session
      if (isInActiveSession) {
        // Clear existing timer
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }

        // Get current delay from settings
        const { delayMs } = getConfig();
        
        // Try to detect if response appears complete right away
        const mightBeCompleteNow = isAIResponseComplete(currentContent);
        if (mightBeCompleteNow) {
          outputChannel.appendLine(`Response may be complete already - short delay check`);
          // Use a shorter delay for likely-complete responses
          debounceTimer = setTimeout(() => {
            outputChannel.appendLine(`\n=== Chat Session Appears Complete (quick check) ===`);
            // Double-check if response still appears complete
            if (isAIResponseComplete(currentContent)) {
              // End the session and play the sound
              isInActiveSession = false;
              documentChangeCount = 0;
              
              playBoop().catch((error) => {
                outputChannel.appendLine(`Failed to play sound: ${error.message}`);
              });
            }
          }, Math.min(1000, delayMs)); // Use a shorter delay (max 1 second)
        } else {
          // Regular completion check with longer delay
          // Use a more responsive delay (between 1-2x configured delay)
          const completionDelay = Math.max(delayMs, 2000);
  
          // Set new timer to detect when chat activity has ended
          debounceTimer = setTimeout(() => {
            // More aggressive check - if we have any AI indicators, consider it complete
            const responseComplete = isAIResponseComplete(currentContent) || 
              (assistantTurnDetected && !currentContent.endsWith("..."));
            
            outputChannel.appendLine(`\n=== Checking for completion after ${completionDelay}ms ===`);
            outputChannel.appendLine(`- Response appears complete: ${responseComplete}`);
            
            if (responseComplete) {
              outputChannel.appendLine(`\n=== Chat Session Ended (AI response complete) ===`);
              // End the session and play the sound
              isInActiveSession = false;
              documentChangeCount = 0;
              humanTurnDetected = false;
              assistantTurnDetected = false;
              
              playBoop().catch((error) => {
                outputChannel.appendLine(`Failed to play sound: ${error.message}`);
              });
            } else {
              outputChannel.appendLine(`AI response still in progress (temporary pause)`);
              
              // Another chance to check in a bit longer, in case we missed it
              debounceTimer = setTimeout(() => {
                // Final check - even more relaxed criteria
                const finalCheck = assistantTurnDetected && currentContent.length > 100;
                
                if (finalCheck) {
                  outputChannel.appendLine(`\n=== Chat Session Ended (final chance check) ===`);
                  isInActiveSession = false;
                  documentChangeCount = 0;
                  humanTurnDetected = false;
                  assistantTurnDetected = false;
                  
                  playBoop().catch((error) => {
                    outputChannel.appendLine(`Failed to play sound: ${error.message}`);
                  });
                }
              }, completionDelay * 1.5);
            }
          }, completionDelay);
        }
      }
    }),

    // Monitor configuration changes
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("cursorChatBeep")) {
        const config = getConfig();
        outputChannel.appendLine("\n=== Configuration Changed ===");
        outputChannel.appendLine(`- Enabled: ${config.enabled}`);
        outputChannel.appendLine(`- Delay: ${config.delayMs}ms`);
        outputChannel.appendLine(`- Sound: ${config.soundFile}`);
        outputChannel.appendLine(`- Volume: ${config.volume}`);
      }
    })
  );

  // Clean up on deactivate
  context.subscriptions.push({
    dispose: () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    },
  });
}

export function deactivate() {}
