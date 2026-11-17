import { Finding } from "../evals/reports";

export interface AgentReport {
  bugs: Finding[];
  flags?: Finding[];
  costUsd: number | null;
  costComplete: boolean;
  durationSeconds: number;
}

export interface AgentReportReader {
  name: string;
  reportDirectory: string;
  getReport(directory: string): Promise<AgentReport>;
}
