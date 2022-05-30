type Query = string;
type Rows = Array<{ [key: string]: any }>;
type Columns = Array<{ name: string; type: string }>;
export type QueryResult = [Query, Rows, Columns];
