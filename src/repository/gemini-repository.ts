import { ContentEmbedding, GoogleGenerativeAI } from "@google/generative-ai";
import * as fs from 'fs';
import * as vscode from "vscode";


export class GeminiRepository {
    private apiKey?: string;
    private genAI: GoogleGenerativeAI;

    constructor(apiKey: string) {
        this.apiKey = apiKey;
        this.genAI = new GoogleGenerativeAI(this.apiKey);
    }

    public async generateTextFromImage(prompt: string, image: string, mimeType: string): Promise<string> {
        const model = this.genAI.getGenerativeModel({ model: "gemini-pro-vision" });
        const imageParts = [
            this.fileToGenerativePart(image, mimeType),
        ];

        const result = await model.generateContent([prompt, ...imageParts]);
        const response = await result.response;
        const text = response.text();
        return text;
    }

    public async getCompletion(prompt: { role: string, parts: string }[], isReferenceAdded?: boolean): Promise<string> {

        if (!this.apiKey) {
            throw new Error('API token not set, please go to extension settings to set it (read README.md for more info)');
        }
        let lastMessage = prompt.pop();
        if (lastMessage && isReferenceAdded) {
            const dartFiles = await this.findClosestDartFiles(lastMessage.parts);
            lastMessage.parts = "Read following workspace code end-to-end and answer the prompt initialised by `@workspace` \n" + dartFiles + "\n\n" + lastMessage.parts;
        }
        console.log("Prompt: " + lastMessage?.parts);
        const chat = this.genAI.getGenerativeModel({ model: "gemini-pro", generationConfig: { temperature: 0.0, topP: 0.2 } }).startChat(
            {
                history: prompt,
            }
        );
        const result = await chat.sendMessage(lastMessage?.parts ?? "");

        const response = result.response;
        const text = response.text();
        return text;
    }

    public async findClosestDartFiles(query: string): Promise<string> {
        const taskType = require("@google/generative-ai");

        if (!this.apiKey) {
            throw new Error('API token not set, please go to extension settings to set it (read README.md for more info)');
        }

        // Initialize the embedding model for document retrieval
        const embedding = this.genAI.getGenerativeModel({ model: "embedding-001" });

        // Find all Dart files in the workspace
        const dartFiles = await vscode.workspace.findFiles('lib/**/*.dart');
        console.log("dartFiles: " + dartFiles.concat().toString());

        // Read the content of each Dart file
        const fileContents = await Promise.all(dartFiles.map(async (file: any) => {
            const document = await vscode.workspace.openTextDocument(file);
            return document.getText();
        }));

        console.log("File content length: " + fileContents.length);

        // Split the fileContents into chunks of 100 or fewer
        const chunkSize = 100;
        const chunks = [];
        for (let i = 0; i < fileContents.length; i += chunkSize) {
            chunks.push(fileContents.slice(i, i + chunkSize));
        }

        console.log("Chunks length: " + chunks.length);

        // Process each chunk to get embeddings
        let docEmbeddings: { embeddings: ContentEmbedding[] } = { embeddings: [] };

        for (const chunk of chunks) {
            const batchEmbeddings = await embedding.batchEmbedContents({
                requests: chunk.map((text) => ({
                    content: { role: "document", parts: [{ text }] },
                    taskType: taskType.RETRIEVAL_DOCUMENT,
                })),
            });
            docEmbeddings.embeddings = docEmbeddings.embeddings.concat(batchEmbeddings.embeddings);
        }

        // Generate embedding for the query
        const queryEmbedding = await embedding.embedContent({
            content: { role: "query", parts: [{ text: query }] },
            taskType: taskType.RETRIEVAL_QUERY
        });

        // Calculate the Euclidean distance between the query embedding and each document embedding
        const distances = docEmbeddings.embeddings.map((embedding, index) => ({
            file: dartFiles[index],
            distance: this.euclideanDistance(embedding.values, queryEmbedding.embedding.values)
        }));

        console.log("Distances length: " + distances.length);

        // Sort the files by their distance to the query embedding in ascending order
        distances.sort((a, b) => Math.abs(a.distance - b.distance));


        // Construct a string with the closest Dart files and their content
        let resultString = '';
        distances.slice(0, 5).forEach((fileEmbedding, index) => {
            const fileName = fileEmbedding.file.path.split('/').pop();
            const fileContent = fileContents[dartFiles.indexOf(fileEmbedding.file)];
            resultString += `${index + 1}. ${fileName}\n`;
            resultString += '```dart\n' + fileContent + '\n```\n\n';
        });

        return resultString.trim();
    }


    private euclideanDistance(a: string | any[], b: number[]) {
        let sum = 0;
        for (let n = 0; n < a.length; n++) {
            sum += Math.pow(a[n] - b[n], 2);
        }
        return Math.sqrt(sum);
    }

    // Converts local file information to a GoogleGenerativeAI.Part object.
    private fileToGenerativePart(path: string, mimeType: string) {
        return {
            inlineData: {
                data: Buffer.from(fs.readFileSync(path)).toString("base64"),
                mimeType
            },
        };
    }

}