/** PipelineStepTrace.outputSummary.selectionDiagnostics.shortfallReasons 统一读取。主链路与日报共用，避免各写一遍 JSON 解析。 */

export const extractShortfallReasons = (outputSummary: unknown): readonly string[] => {
  if (!outputSummary || typeof outputSummary !== 'object') {
    return [];
  }
  const diagnostics = (outputSummary as Record<string, unknown>).selectionDiagnostics;
  if (!diagnostics || typeof diagnostics !== 'object') {
    return [];
  }
  const reasons = (diagnostics as Record<string, unknown>).shortfallReasons;
  if (!Array.isArray(reasons)) {
    return [];
  }
  return reasons.filter((r): r is string => typeof r === 'string');
};

interface IMinimalPgPool {
  query: <T>(sql: string, values?: readonly unknown[]) => Promise<{ rows: readonly T[] }>;
}

interface IStepTraceRow {
  readonly output_summary: Record<string, unknown> | null;
}

export const readShortfallReasonsByTrace = async (
  pool: IMinimalPgPool | undefined,
  traceId: string,
): Promise<readonly string[]> => {
  if (!pool || !traceId) {
    return [];
  }
  try {
    const rows = await pool.query<IStepTraceRow>(
      [
        'SELECT "outputSummary" AS output_summary',
        'FROM public."PipelineStepTrace"',
        'WHERE "traceId" = $1 AND "stepName" = \'recommendation\'',
        'LIMIT 1',
      ].join(' '),
      [traceId],
    );
    return extractShortfallReasons(rows.rows[0]?.output_summary ?? null);
  }
  catch {
    return [];
  }
};
