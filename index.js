
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const { authenticate } = require("@google-cloud/local-auth");

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  ListToolsRequestSchema,
  CallToolRequestSchema
} = require("@modelcontextprotocol/sdk/types.js");

const server = new Server(
  {
    name: "my-first-mcp",
    version: "1.0.0"
  },
  {
    capabilities: { tools: {} }
  }
);

const CREDENTIALS_PATH = path.join(__dirname, "credentials.json");
const TOKEN_PATH = path.join(__dirname, "token.json");

async function authorize() {
  const credentials = JSON.parse(
    fs.readFileSync(CREDENTIALS_PATH, "utf8")
  );

  const keys = credentials.installed || credentials.web;

  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));

    const auth = new google.auth.OAuth2(
      keys.client_id,
      keys.client_secret,
      keys.redirect_uris[0]
    );

    auth.setCredentials(token);
    return auth;
  }

  const auth = await authenticate({
    keyfilePath: CREDENTIALS_PATH,
    scopes: [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/spreadsheets"
    ]
  });

  fs.writeFileSync(TOKEN_PATH, JSON.stringify(auth.credentials));
  return auth;
}

function columnToLetter(columnNumber) {
  let result = "";

  while (columnNumber > 0) {
    const remainder = (columnNumber - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    columnNumber = Math.floor((columnNumber - 1) / 26);
  }

  return result;
}

server.setRequestHandler(
  ListToolsRequestSchema,
  async () => ({
    tools: [
      {
        name: "search_google_drive",
        description: "Search for files in Google Drive by name or content",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" }
          },
          required: ["name"]
        }
      },
      {
        name: "read_google_sheet",
        description: "Read data from a Google Sheet",
        inputSchema: {
          type: "object",
          properties: {
            spreadsheet_id: { type: "string" },
            range: { type: "string" }
          },
          required: ["spreadsheet_id"]
        }
      },
      {
        name: "search_customer",
        description: "Search for a customer by name in a Google Sheet",
        inputSchema: {
          type: "object",
          properties: {
            spreadsheet_id: { type: "string" },
            name: { type: "string" }
          },
          required: ["spreadsheet_id", "name"]
        }
      },
      {
        name: "search_customer_by_email",
        description: "Search for a customer by email in a Google Sheet",
        inputSchema: {
          type: "object",
          properties: {
            spreadsheet_id: { type: "string" },
            email: { type: "string" }
          },
          required: ["spreadsheet_id", "email"]
        }
      },
      {
        name: "search_customer_by_status",
        description: "Search for customers by status in a Google Sheet",
        inputSchema: {
          type: "object",
          properties: {
            spreadsheet_id: { type: "string" },
            status: { type: "string" }
          },
          required: ["spreadsheet_id", "status"]
        }
      },
      {
        name: "add_customer",
        description: "Add a new customer to a Google Sheet",
        inputSchema: {
          type: "object",
          properties: {
            spreadsheet_id: { type: "string" },
            name: { type: "string" },
            email: { type: "string" },
            message: { type: "string" },
            status: { type: "string" }
          },
          required: [
            "spreadsheet_id",
            "name",
            "email",
            "message",
            "status"
          ]
        }
      },
      {
        name: "update_customer_status",
        description: "Update a customer's status using their email address",
        inputSchema: {
          type: "object",
          properties: {
            spreadsheet_id: { type: "string" },
            email: { type: "string" },
            status: { type: "string" }
          },
          required: ["spreadsheet_id", "email", "status"]
        }
      }
    ]
  })
);

server.setRequestHandler(
  CallToolRequestSchema,
  async (request) => {
    const toolName = request.params.name;
    const args = request.params.arguments || {};

    try {
      const auth = await authorize();

      if (toolName === "search_google_drive") {
        const drive = google.drive({ version: "v3", auth });
        const name = args.name;

        const escaped = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

        const result = await drive.files.list({
          q: `trashed = false and (name contains '${escaped}' or fullText contains '${escaped}')`,
          pageSize: 20,
          fields: "files(id, name, mimeType, webViewLink)"
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify(result.data.files, null, 2)
          }]
        };
      }

      if (toolName === "read_google_sheet") {
        const sheets = google.sheets({ version: "v4", auth });

        const result = await sheets.spreadsheets.values.get({
          spreadsheetId: args.spreadsheet_id,
          range: args.range || "A1:Z100"
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify(result.data.values || [], null, 2)
          }]
        };
      }

      if (
        toolName === "search_customer" ||
        toolName === "search_customer_by_email" ||
        toolName === "search_customer_by_status"
      ) {
        const sheets = google.sheets({ version: "v4", auth });

        const result = await sheets.spreadsheets.values.get({
          spreadsheetId: args.spreadsheet_id,
          range: "A1:Z100"
        });

        const rows = result.data.values || [];
        const headers = rows[0] || [];
        const customers = rows.slice(1);

        let columnName;
        let searchValue;

        if (toolName === "search_customer") {
          columnName = "name";
          searchValue = args.name;
        } else if (toolName === "search_customer_by_email") {
          columnName = "email";
          searchValue = args.email;
        } else {
          columnName = "status";
          searchValue = args.status;
        }

        const searchColumn = headers.findIndex(
          header =>
            String(header || "").trim().toLowerCase() === columnName
        );

        if (searchColumn === -1) {
          throw new Error(`Required column not found: ${columnName}`);
        }

        const normalizedSearch = String(searchValue || "")
          .trim()
          .toLowerCase();

        if (!normalizedSearch) {
          throw new Error("Search value cannot be empty.");
        }

        const matches = customers.filter(row =>
          String(row[searchColumn] || "")
            .trim()
            .toLowerCase() === normalizedSearch
        );

        const output = matches.map(row => {
          const customer = {};

          headers.forEach((header, index) => {
            customer[header] = row[index] || "";
          });

          return customer;
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify(output, null, 2)
          }]
        };
      }

      if (toolName === "add_customer") {
        const sheets = google.sheets({ version: "v4", auth });

        const values = [[
          args.name,
          args.email,
          args.message,
          args.status
        ]];

        const result = await sheets.spreadsheets.values.append({
          spreadsheetId: args.spreadsheet_id,
          range: "A:D",
          valueInputOption: "USER_ENTERED",
          insertDataOption: "INSERT_ROWS",
          requestBody: { values }
        });

        return {
          content: [{
            type: "text",
            text: "Customer added successfully!\n" +
              JSON.stringify(result.data.updates, null, 2)
          }]
        };
      }

      if (toolName === "update_customer_status") {
        const sheets = google.sheets({ version: "v4", auth });

        const result = await sheets.spreadsheets.values.get({
          spreadsheetId: args.spreadsheet_id,
          range: "A1:Z100"
        });

        const rows = result.data.values || [];
        const headers = rows[0] || [];

        const emailColumn = headers.findIndex(
          header =>
            String(header || "").trim().toLowerCase() === "email"
        );

        const statusColumn = headers.findIndex(
          header =>
            String(header || "").trim().toLowerCase() === "status"
        );

        if (emailColumn === -1 || statusColumn === -1) {
          throw new Error("Email or status column was not found.");
        }

        const searchEmail = String(args.email || "")
          .trim()
          .toLowerCase();

        const newStatus = String(args.status || "").trim();

        if (!searchEmail || !newStatus) {
          throw new Error("Email and new status are required.");
        }

        const matchingRows = [];

        for (let i = 1; i < rows.length; i++) {
          const rowEmail = String(rows[i][emailColumn] || "")
            .trim()
            .toLowerCase();

          if (rowEmail === searchEmail) {
            matchingRows.push(i + 1);
          }
        }

        if (matchingRows.length === 0) {
          throw new Error("No customer found with that email.");
        }

        if (matchingRows.length > 1) {
          throw new Error(
            "Multiple customers have this email. Update cancelled to avoid changing the wrong record."
          );
        }

        const rowNumber = matchingRows[0];
        const statusColumnLetter = columnToLetter(statusColumn + 1);
        const updateRange =
          `'Sheet1'!${statusColumnLetter}${rowNumber}`;

        await sheets.spreadsheets.values.update({
          spreadsheetId: args.spreadsheet_id,
          range: updateRange,
          valueInputOption: "USER_ENTERED",
          requestBody: {
            values: [[newStatus]]
          }
        });

        return {
          content: [{
            type: "text",
            text:
              `Customer status updated successfully!\n` +
              `Email: ${searchEmail}\n` +
              `New status: ${newStatus}\n` +
              `Updated row: ${rowNumber}`
          }]
        };
      }

      throw new Error("Unknown tool: " + toolName);

    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Google API error: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
