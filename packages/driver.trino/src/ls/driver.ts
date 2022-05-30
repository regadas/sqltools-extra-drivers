import AbstractDriver from "@sqltools/base-driver";
import queries from "./queries";
import {
  IConnectionDriver,
  MConnectionExplorer,
  NSDatabase,
  ContextValue,
  Arg0,
} from "@sqltools/types";
import { v4 as generateId } from "uuid";
import presto from "presto-client";
import { QueryResult } from "./types";
import { QueryParser } from "./parser";

type DriverLib = typeof presto.Client;
type DriverOptions = any;

export default class TrinoDriver
  extends AbstractDriver<DriverLib, DriverOptions>
  implements IConnectionDriver {
  queries = queries;

  public async open(): Promise<presto.Client> {
    if (this.connection) {
      return this.connection;
    }

    const connOptions = {
      host: this.credentials.host,
      port: this.credentials.port,
      catalog: this.credentials.catalog,
      schema: this.credentials.schema,
      user: this.credentials.user,
      engine: "trino",
      source: "sqltools-driver",
    };

    if (this.credentials.password) {
      connOptions["basic_auth"] = {
        user: this.credentials.user,
        password: this.credentials.password,
      };
    }

    try {
      const conn = new presto.Client(connOptions);
      this.connection = Promise.resolve(conn);
    } catch (error) {
      return Promise.reject(error);
    }

    return this.connection;
  }

  public async close(): Promise<void> {
    if (!this.connection) return Promise.resolve();
    await this.connection;
    this.connection = null;
  }

  private async executeQuery(db: presto.Client, query: string): Promise<QueryResult> {
    return await new Promise<QueryResult>((resolve, reject) => {
      const results = [];
      let cols = [];

      const onData = (error, rows, columns, _) => {
        if (error) return reject(error);

        cols = columns;
        rows.forEach((row: any[]) => {
          const data = {};
          row.forEach((value, idx) => (data[columns[idx].name] = value));
          results.push(data);
        });
      };

      const callback = (error, _) => {
        if (error) return reject(error);
        resolve([query, results, cols]);
      };

      db.execute({ query: query, data: onData, callback: callback });
    });
  }

  public query: typeof AbstractDriver["prototype"]["query"] = async (
    query: string,
    opt = {}
  ) => {
    const { requestId } = opt;
    const resultsAgg: NSDatabase.IResult[] = [];
    const db = await this.open();

    for (const q of QueryParser.statements(query)) {
      const iresult: NSDatabase.IResult = await this.executeQuery(db, q)
        .then((result) => {
          const [q, rows, columns] = result;
          return <NSDatabase.IResult>{
            requestId,
            resultId: generateId(),
            connId: this.getId(),
            cols: columns.map((col) => col.name),
            results: rows,
            messages: [
              this.prepareMessage(
                [`Successfully executed. ${rows.length} rows were affected.`]
                  .filter(Boolean)
                  .join(" ")
              ),
            ],
            query: q,
          };
        })
        .catch((error) => <NSDatabase.IResult>{
          connId: this.getId(),
          requestId,
          resultId: generateId(),
          cols: [],
          messages: [
            this.prepareMessage(
              [error.message.replace(/\n/g, " ")].filter(Boolean).join(" ")
            ),
          ],
          error: true,
          rawError: error,
          query,
          results: [],
        });

      resultsAgg.push(iresult);
    }

    return resultsAgg;
  };

  public async testConnection() {
    await this.open();
    const testSelect = await this.query("SELECT 1", {});

    if (testSelect.length > 0 && testSelect[0].error) {
      const msg = testSelect[0].messages
        .map((m: { message: string; date: Date }) => m.message)
        .join("\n");

      return Promise.reject({ message: msg });
    }
  }

  /**
   * This method is a helper to generate the connection explorer tree.
   * it gets the child items based on current item
   */
  public async getChildrenForItem({
    item,
    parent,
  }: Arg0<IConnectionDriver["getChildrenForItem"]>) {
    switch (item.type) {
      case ContextValue.CONNECTION:
      case ContextValue.CONNECTED_CONNECTION:
        return this.queryResults(
          queries.fetchSchemas({
            database: this.credentials.catalog,
          } as NSDatabase.IDatabase)
        );
      case ContextValue.SCHEMA:
        return <MConnectionExplorer.IChildItem[]>[
          {
            label: "Tables",
            type: ContextValue.RESOURCE_GROUP,
            iconId: "folder",
            childType: ContextValue.TABLE,
          },
          {
            label: "Views",
            type: ContextValue.RESOURCE_GROUP,
            iconId: "folder",
            childType: ContextValue.VIEW,
          },
        ];
      case ContextValue.TABLE:
      case ContextValue.VIEW:
        return this.queryResults(
          queries.fetchColumns(item as NSDatabase.ITable)
        );
      case ContextValue.RESOURCE_GROUP:
        return this.getChildrenForGroup({ item, parent });
    }
    return [];
  }

  /**
   * This method is a helper to generate the connection explorer tree.
   * It gets the child based on child types
   */
  private async getChildrenForGroup({
    parent,
    item,
  }: Arg0<IConnectionDriver["getChildrenForItem"]>) {
    switch (item.childType) {
      case ContextValue.TABLE:
        return this.queryResults(
          queries.fetchTables(parent as NSDatabase.ISchema)
        );
      case ContextValue.VIEW:
        return this.queryResults(
          queries.fetchViews(parent as NSDatabase.ISchema)
        );
    }
    return [];
  }

  /**
   * This method is a helper for intellisense and quick picks.
   */
  public async searchItems(
    itemType: ContextValue,
    search: string,
    _extraParams: any = {}
  ): Promise<NSDatabase.SearchableItem[]> {
    switch (itemType) {
      case ContextValue.TABLE:
      case ContextValue.VIEW:
        return this.queryResults(queries.searchTables({ search }));
      case ContextValue.COLUMN:
        return this.queryResults(
          queries.searchColumns({ search, ..._extraParams })
        );
    }
    return [];
  }

  public getStaticCompletions: IConnectionDriver["getStaticCompletions"] =
    async () => {
      return {};
    };
}
