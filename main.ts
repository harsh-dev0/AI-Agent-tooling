import * as readline from "readline"
import { Groq } from "groq-sdk"
import dotenv from "dotenv"
import { JSONSchema7 } from "json-schema"
import { promises as fs } from "fs"

dotenv.config()
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! })
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})
const askUser = (q: string) =>
  new Promise<string>((res) => rl.question(q, res))

type Message = {
  role: "system" | "user" | "assistant"
  content: string
}

interface ToolDefinition {
  name: string
  description: string
  inputSchema: JSONSchema7
  function: (input: any) => Promise<string>
}
function createSpinner(message = "Thinking...") {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  let i = 0
  process.stdout.write(message + " ")

  const interval = setInterval(() => {
    process.stdout.write("\r" + message + " " + frames[i])
    i = (i + 1) % frames.length
  }, 100)

  return {
    stop: (suffix = "✅ Done.") => {
      clearInterval(interval)
      process.stdout.write("\r" + message + " " + suffix + "\n")
    },
  }
}

const readFileTool: ToolDefinition = {
  name: "read_file",
  description:
    "Reads the contents of a file at a given relative path. Only use for text files.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative path, e.g. './package.json'",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  function: async ({ path }: { path: string }) => {
    try {
      return await fs.readFile(path, "utf-8")
    } catch (e) {
      return `❌ Error reading file: ${(e as Error).message}`
    }
  },
}

const listFilesTool: ToolDefinition = {
  name: "list_files",
  description:
    "Lists files and directories at a given path. Defaults to '.' if no path provided.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Optional path to list contents from.",
      },
    },
    required: [],
    additionalProperties: false,
  },
  function: async ({ path = "." }: { path?: string }) => {
    try {
      const entries = await fs.readdir(path, { withFileTypes: true })
      const list = entries.map((e) =>
        e.isDirectory() ? e.name + "/" : e.name
      )
      return JSON.stringify(list, null, 2)
    } catch (e) {
      return `❌ Error listing files: ${(e as Error).message}`
    }
  },
}
const editFileTool: ToolDefinition = {
  name: "edit_file",
  description: `Make edits to a text file.

Replaces 'old_str' with 'new_str' in the given file. 'old_str' and 'new_str' MUST be different from each other.

If the file specified with path doesn't exist, it will be created.`,
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file",
      },
      old_str: {
        type: "string",
        description: "Text to search for",
      },
      new_str: {
        type: "string",
        description: "Text to replace old_str with",
      },
    },
    required: ["path", "old_str", "new_str"],
    additionalProperties: false,
  },
  function: async ({
    path,
    old_str,
    new_str,
  }: {
    path: string
    old_str: string
    new_str: string
  }) => {
    if (!path || old_str === new_str) {
      return "❌ Invalid input parameters."
    }

    try {
      const content = await fs.readFile(path, "utf-8")
      if (!content.includes(old_str)) {
        return "❌ old_str not found in file."
      }
      const newContent = content.replace(new RegExp(old_str, "g"), new_str)
      await fs.writeFile(path, newContent)
      return "✅ File edited successfully."
    } catch (err) {
      if (
        (err as NodeJS.ErrnoException).code === "ENOENT" &&
        old_str === ""
      ) {
        try {
          await fs.mkdir(require("path").dirname(path), {
            recursive: true,
          })
          await fs.writeFile(path, new_str)
          return `✅ Created new file at ${path}`
        } catch (e) {
          return `❌ Failed to create file: ${(e as Error).message}`
        }
      } else {
        return `❌ Error editing file: ${(err as Error).message}`
      }
    }
  },
}
const deleteFileTool: ToolDefinition = {
  name: "delete_file",
  description: "Delete a file or directory.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File or directory path to delete",
      },
    },
    required: ["path"],
  },
  function: async ({ path }) => {
    try {
      await fs.rm(path, { recursive: true, force: true }) // `recursive` for directories
      return `Successfully deleted: ${path}`
    } catch (err) {
      return `Error deleting file: ${(err as Error).message}`
    }
  },
}

const tools = [readFileTool, listFilesTool, editFileTool, deleteFileTool]

const conversation: Message[] = [
  {
    role: "system",
    content: `
    
You are an AI assistant with access to three tools:
Only use these tools whenever you think it will help th query
1) list_files(path?: string)  
   • Description: ${listFilesTool.description}  
   • Input schema: ${JSON.stringify(listFilesTool.inputSchema)}

2) read_file(path: string)  
   • Description: ${readFileTool.description}  
   • Input schema: ${JSON.stringify(readFileTool.inputSchema)}
3) edit_file(path: string, old_str: string, new_str: string)
   • Description: ${editFileTool.description}
   • Input schema: ${JSON.stringify(editFileTool.inputSchema)}
4) delete_file(path: string)
   • Description: ${deleteFileTool.description}
   • Input schema: ${JSON.stringify(deleteFileTool.inputSchema)}

You are a powerful agentic AI coding assistant. 

You are pair programming with a USER to solve their coding task.
The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.
Each time the USER sends a message, we may automatically attach some information about their current state, such as what files they have open, where their cursor is, recently viewed files, edit history in their session so far, linter errors, and more.
This information may or may not be relevant to the coding task, it is up for you to decide.
Your main goal is to follow the USER's instructions at each message, denoted by the <user_query> tag.

You have tools at your disposal to solve the coding task. Follow these rules regarding tool calls:
1. ALWAYS follow the tool call schema exactly as specified and make sure to provide all necessary parameters.
2. The conversation may reference tools that are no longer available. NEVER call tools that are not explicitly provided.
3. **NEVER refer to tool names when speaking to the USER.** For example, instead of saying 'I need to use the edit_file tool to edit your file', just say 'I will edit your file'.
4. Only calls tools when they are necessary. If the USER's task is general or you already know the answer, just respond without calling tools.
5. Before calling each tool, first explain to the USER why you are calling it.

Example:
<tool_call>
{"name":"list_files","input":{"path":"./"}}
</tool_call>

After the tool result, you will get that output as a user message. Then continue reasoning or call another tool.  
If you do _not_ need a tool, just reply normally.
    `.trim(),
  },
]

async function handleToolCall(response: string): Promise<string | null> {
  const match = response.match(/<tool_call>([\s\S]*?)<\/tool_call>/)
  if (!match) return null

  try {
    const call = JSON.parse(match[1])
    const tool = tools.find((t) => t.name === call.name)
    if (!tool) return `❌ Unknown tool: ${call.name}`

    const result = await tool.function(call.input)

    conversation.push({ role: "assistant", content: response })
    conversation.push({ role: "user", content: `Tool result:\n${result}` })
    return result
  } catch (e) {
    return `❌ Tool error: ${(e as Error).message}`
  }
}
function parseToolCall(text: string): { name: string; input: any } | null {
  const match = text.match(/<tool_call>([\s\S]*?)<\/tool_call>/)
  if (!match) return null
  try {
    return JSON.parse(match[1])
  } catch {
    return null
  }
}

async function runAgent(): Promise<void> {
  console.log("🤖 Groq + LLaMA3 Agent with Tools — let’s go!")

  while (true) {
    const userInput = await askUser("\x1b[36mYou:\x1b[0m ")
    conversation.push({ role: "user", content: userInput })

    let done = false
    while (!done) {
      const spinner = createSpinner("🧠 Thinking...")
      const res = await groq.chat.completions.create({
        model: "llama3-70b-8192",
        messages: conversation,
        temperature: 0.7,
      })
      spinner.stop()
      const reply = res.choices[0]?.message?.content ?? ""

      const call = parseToolCall(reply)
      if (call) {
        const thought = reply.split("<tool_call>")[0].trim()
        if (thought) {
          console.log("\x1b[33mAgent:\x1b[0m", thought)
        }
        conversation.push({ role: "assistant", content: reply })
        console.log(
          "\x1b[33mAgent (calling tool):\x1b[0m",
          call.name,
          call.input
        )

        const tool = tools.find((t) => t.name === call.name)
        const result = tool
          ? await tool.function(call.input)
          : `❌ Unknown tool: ${call.name}`

        console.log("\x1b[35mTool Output:\x1b[0m", result)

        conversation.push({
          role: "user",
          content: `Tool result:\n${result}`,
        })
      } else {
        console.log("\x1b[33mAgent:\x1b[0m", reply)
        conversation.push({ role: "assistant", content: reply })
        done = true
      }
    }
  }
}

runAgent().catch((err) => {
  console.error("❌ Fatal Error:", err)
  rl.close()
})
