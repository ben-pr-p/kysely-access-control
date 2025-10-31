import {
  ColumnNode,
  DeleteQueryNode,
  ExpressionWrapper,
  InsertQueryNode,
  KyselyPlugin,
  OperationNodeTransformer,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  QueryResult,
  ReferenceNode,
  ReturningNode,
  RootOperationNode,
  SelectQueryNode,
  SelectionNode,
  TableNode,
  UnknownRow,
  UpdateQueryNode,
  OperationNode,
  AliasNode,
  AndNode,
  FromNode,
  IdentifierNode,
  JoinNode,
  SqlBool,
  UsingNode,
  WhereNode,
} from "kysely";

import invariant from "tiny-invariant";

export const Allow = "allow" as const;
export const Deny = "deny" as const;
export const Omit = "omit" as const;

type TAllow = typeof Allow;
type TDeny = typeof Deny;
type TOmit = typeof Omit;

export enum StatementType {
  Select = "select",
  Insert = "insert",
  Update = "update",
  Delete = "delete",
}

export enum ColumnUsageContext {
  ColumnInSelectOrReturning = "column-in-select-or-returning",
  ColumnInWhereOrJoin = "column-in-where-or-join",
  ColumnInUpdateSet = "column-in-update-set",
  ColumnInInsert = "column-in-insert",
}

export enum TableUsageContext {
  TableTopLevel = "table-top-level",
  TableInJoin = "table-in-join",
}

type TableGuardResult<KyselyDatabase> =
  | TAllow
  | [TAllow, ExpressionWrapper<KyselyDatabase, any, SqlBool>]
  | TDeny
  | [TDeny, string];

type ColumnGuardResult = TAllow | TOmit | TDeny | [TDeny, string];

type TableNodeTable = TableNode["table"];
type TableNodeTableIdentifierWithNamesAsKeyOf<KyselyDatabase> = Omit<
  TableNodeTable["identifier"],
  "name"
> & { name: keyof KyselyDatabase };

type TableNodeTableWithKeyOf<KyselyDatabase> = Omit<
  TableNodeTable,
  "identifier"
> & { identifier: TableNodeTableIdentifierWithNamesAsKeyOf<KyselyDatabase> };

export const throwIfDenyWithReason = (
  guardResult: ColumnGuardResult | TableGuardResult<unknown>,
  coreErrorString: string
): void => {
  if (guardResult === Deny) {
    throw new Error(coreErrorString);
  }

  if (guardResult[0] === Deny) {
    throw new Error(`${coreErrorString}: ${guardResult[1]}`);
  }
};

type FullKyselyAccessControlGuard<KyselyDatabase = unknown> = {
  table: (
    table: TableNodeTableWithKeyOf<KyselyDatabase>,
    statementType: StatementType,
    tableUsageContext: TableUsageContext
  ) => TableGuardResult<KyselyDatabase>;

  column: (
    table: TableNodeTableWithKeyOf<KyselyDatabase>,
    column: ColumnNode["column"],
    statementType: StatementType,
    columnUsageContext: ColumnUsageContext
  ) => ColumnGuardResult;
};

export type KyselyAccessControlGuard<KyselyDatabase = unknown> = Partial<
  FullKyselyAccessControlGuard<KyselyDatabase>
>;

type UnrestrictedInternalKyselyDatabase = Record<
  string,
  Record<string, string>
>;

export const createAccessControlPlugin = <KyselyDatabase = unknown>(
  guard: KyselyAccessControlGuard<KyselyDatabase>
): KyselyPlugin => {
  // 2 things are accomplished in this translation into fullGuard
  // 1. Default guards are provided if the user does not provide either .table or .column
  // 2. We lose table and column keyof typings so that we can safely call these guards internally
  //    without extra coercion
  const fullGuard: FullKyselyAccessControlGuard<UnrestrictedInternalKyselyDatabase> =
    {
      table: () => {
        return Allow;
      },
      column: () => {
        return Allow;
      },
      ...(guard as KyselyAccessControlGuard<UnrestrictedInternalKyselyDatabase>),
    };

  type OperationNodeWithIs = {
    is: (node: OperationNode) => boolean;
  };

  class Transformer extends OperationNodeTransformer {
    private getParentNode() {
      return this.nodeStack[this.nodeStack.length - 2]; // last element is the current one, one before is the parent
    }

    private isAChildOf(nodeType: OperationNodeWithIs): boolean {
      return this.nodeStack.find((node) => nodeType.is(node)) !== undefined;
    }

    /**
     * Enforce update on a table
     * - enforces whether the table is allowed to be updated
     * - enforce the target columns to be updated
     */
    protected transformUpdateQuery(node: UpdateQueryNode): UpdateQueryNode {
      const tableNode = node.table;

      invariant(
        TableNode.is(tableNode),
        "kysely-access-control: only table nodes are supported for update queries"
      );

      const guardResult = fullGuard.table(
        tableNode.table,
        StatementType.Update,
        TableUsageContext.TableTopLevel
      );

      throwIfDenyWithReason(
        guardResult,
        `UPDATE denied on table ${
          tableNode.table.schema?.name ? `${tableNode.table.schema.name}.` : ""
        }${tableNode.table.identifier.name}`
      );

      // Enforce column permissions
      if (node.updates) {
        for (const columnUpdateNode of node.updates) {
          const column = columnUpdateNode.column;

          const guardResult = fullGuard.column(
            tableNode.table,
            column.column,
            StatementType.Update,
            ColumnUsageContext.ColumnInUpdateSet
          );

          throwIfDenyWithReason(
            guardResult,
            `UPDATE denied on column ${
              tableNode.table.schema?.name
                ? `${tableNode.table.schema.name}.`
                : ""
            }${tableNode.table.identifier.name}.${column.column.name}`
          );

          if (guardResult === Omit) {
            throw new Error(
              `Omit is not supported in update set: got Omit for ${column.column.name}`
            );
          }
        }
      }

      // Apply RLS filter from grants to WHERE clause
      const newNode = {
        ...node,
        where: this._transformWhere(guardResult, node.where),
      };

      return super.transformUpdateQuery(newNode);
    }

    /**
     * Enforce insert on a table
     * - enforces whether the table is allowed to be inserted into
     *
     * Enforcement of returning limitations is handled in transformReturning
     */
    protected transformInsertQuery(node: InsertQueryNode): InsertQueryNode {
      const tableNode = node.into;
      const columns = node.columns;

      const guardResult = fullGuard.table(
        tableNode.table,
        StatementType.Insert,
        TableUsageContext.TableTopLevel
      );

      throwIfDenyWithReason(
        guardResult,
        `INSERT denied on table ${
          tableNode.table.schema?.name ? `${tableNode.table.schema.name}.` : ""
        }${tableNode.table.identifier.name}`
      );

      // Skip column enforcement if there are none
      if (columns === undefined) {
        return super.transformInsertQuery(node);
      }

      const transformedColumns: ColumnNode[] = [];
      for (const column of columns) {
        const guardResult = fullGuard.column(
          tableNode.table,
          column.column,
          StatementType.Insert,
          ColumnUsageContext.ColumnInInsert
        );

        throwIfDenyWithReason(
          guardResult,
          `INSERT denied on column ${
            tableNode.table.schema?.name
              ? `${tableNode.table.schema.name}.`
              : ""
          }${tableNode.table.identifier.name}.${column.column.name}`
        );

        if (guardResult === Omit) {
          continue;
        }

        transformedColumns.push(column);
      }

      return super.transformInsertQuery({
        ...node,
        columns: transformedColumns,
      });
    }

    /**
     * Handles enforcement of column permissions in returning
     * for insert/update/delete
     */
    protected transformReturning(node: ReturningNode): ReturningNode {
      // Check whether it's insert, update, or delete via node stack
      const parentNode = this.getParentNode();

      const mode = InsertQueryNode.is(parentNode)
        ? StatementType.Insert
        : UpdateQueryNode.is(parentNode)
        ? StatementType.Update
        : DeleteQueryNode.is(parentNode)
        ? StatementType.Delete
        : undefined;

      invariant(
        mode !== undefined,
        `kysely-access-control: returning must be used with insert, update, or delete. kind was ${parentNode.kind}`
      );

      const { selections } = node;

      const [statementType, tableNode] = InsertQueryNode.is(parentNode)
        ? [StatementType.Insert, parentNode.into]
        : UpdateQueryNode.is(parentNode)
        ? [StatementType.Update, parentNode.table]
        : DeleteQueryNode.is(parentNode)
        ? [StatementType.Delete, parentNode.from.froms[0]]
        : [undefined, undefined];

      // Only inserting into a table is supported
      invariant(
        statementType !== undefined,
        "kysely-access-control: currently only insert/update/delete returning is supported"
      );

      invariant(
        TableNode.is(tableNode),
        "kysely-access-control: currently only update/delete from a table"
      );

      const transformedSelections = this._transformSelections(
        selections.slice(),
        tableNode,
        false,
        statementType
      );

      const transformedNode = {
        ...node,
        selections: transformedSelections,
      };

      return super.transformReturning(transformedNode);
    }

    /**
     * Enforce delete on a table
     * - enforces whether the table is allowed to be deleted from
     */
    protected transformDeleteQuery(node: DeleteQueryNode): DeleteQueryNode {
      // Ensure only 1 from and that its a table
      invariant(
        node.from.froms.length === 1,
        "kysely-access-control: can only delete from one table at a time"
      );

      const tableNode = node.from.froms[0];

      invariant(
        TableNode.is(tableNode),
        "kysely-access-control: can only delete from tables"
      );

      const guardResult = fullGuard.table(
        tableNode.table,
        StatementType.Delete,
        TableUsageContext.TableTopLevel
      );

      throwIfDenyWithReason(
        guardResult,
        `DELETE denied on table ${
          tableNode.table.schema?.name ? `${tableNode.table.schema.name}.` : ""
        }${tableNode.table.identifier.name}`
      );

      // Must be allow - TODO add RLS
      return super.transformDeleteQuery(node);
    }

    /**
     * In transformSelectQuery, we:
     * - throw if any columns are selected that shouldn't be
     * - omit any columns we should omit (throwing if selectAll is used)
     */
    protected transformSelectQuery(node: SelectQueryNode): SelectQueryNode {
      const { from: fromNode, selections, joins, where } = node;

      if (!fromNode) {
        // This covers queries such as select 1, or select following only by subselects
        // We do nothing here
        return super.transformSelectQuery(node);
      }

      invariant(
        fromNode.froms.length === 1,
        "kysely-access-control: there must be exactly one from node when not joining"
      );

      const tableNode = fromNode.froms[0];

      invariant(
        TableNode.is(tableNode),
        "kysely-access-control: currently only select from table/view is supported"
      );

      invariant(
        selections !== undefined,
        "kysely-access-control: selections should be defined"
      );

      const table = tableNode.table;

      const guardResult = fullGuard.table(
        table,
        StatementType.Select,
        TableUsageContext.TableTopLevel
      );

      throwIfDenyWithReason(
        guardResult,
        `SELECT denied on table ${
          table.schema?.name ? `${table.schema.name}.` : ""
        }${table.identifier.name}`
      );

      /* COLUMN ENFORCEMENT */

      // Some selected columns include a table, some don't
      // If there's no joins and therefore only one valid relation to reference
      // we can assume that the column's table is the same as the fromNode's table
      //
      // If there is a join, we require that the user specifies the table
      // Even though kysely's type system and SQL engines can resolve the reference,
      // We cannot
      const hasJoin = joins !== undefined && joins.length > 0;

      const transformedSelections = this._transformSelections(
        selections.slice(),
        tableNode,
        hasJoin,
        StatementType.Select
      );

      const newNode = {
        ...node,
        selections: transformedSelections,
        where: this._transformWhere(guardResult, node.where),
      };

      return super.transformSelectQuery(newNode);
    }

    /**
     * Next 3 methods enforce table level permissions
     * included Allow/Deny and row level permissions
     * for the 3 different types of joins:
     *  - select * from x join y on x.key = y.key
     *  - update x from y where x.key = y.key
     *  - delete from x using y where x.key = y.key
     */

    protected transformJoin(node: JoinNode): JoinNode {
      const tableNode = node.table;

      if (!TableNode.is(tableNode)) {
        // If it's not a table node (it's an alias node with a subselect, etc.)
        // Any enforcement needed will happen on those components
        return super.transformJoin(node);
      }

      const guardResult = fullGuard.table(
        tableNode.table,
        StatementType.Select,
        TableUsageContext.TableInJoin
      );

      throwIfDenyWithReason(
        guardResult,
        `JOIN denied on table ${
          tableNode.table.schema?.name ? `${tableNode.table.schema.name}.` : ""
        }${tableNode.table.identifier.name}`
      );

      if (guardResult === Allow) {
        return super.transformJoin(node);
      }

      // If RLS is applied, replace the table node with a select node that has the RLS applied inline
      // This means replacing the "table" with an AliasNode of a SelectQueryNode + identifier with the same name
      // Fortunately, our top level transformSelectQueryBuilder will handle applying RLS
      // We just need to transform it to a SelectQueryBuilder with an alias so that those
      // transformations can happen
      const newTable = AliasNode.create(
        SelectQueryNode.cloneWithSelections(
          SelectQueryNode.createFrom([tableNode]),
          [SelectionNode.createSelectAll()]
        ),
        IdentifierNode.create(tableNode.table.identifier.name)
      );

      return super.transformJoin({
        ...node,
        table: newTable,
      });
    }

    protected transformFrom(node: FromNode): FromNode {
      const parentNode = this.getParentNode();

      if (!UpdateQueryNode.is(parentNode)) {
        return super.transformFrom(node);
      }

      const newFroms = node.froms.map((from) => {
        if (!TableNode.is(from)) {
          // Only guard tables - non tables (subselects) will be handled further down in
          // the internal SelectQueryNode
          return from;
        }

        const guardResult = fullGuard.table(
          from.table,
          StatementType.Update,
          TableUsageContext.TableInJoin
        );

        throwIfDenyWithReason(
          guardResult,
          `JOIN denied on table ${
            from.table.schema?.name ? `${from.table.schema.name}.` : ""
          }${from.table.identifier.name}`
        );

        if (guardResult === Allow) {
          return from;
        }

        // Must be an RLS case
        // Again, don't worry about the where clauses
        // those will be handled by the internal SelectQueryNode
        return AliasNode.create(
          SelectQueryNode.cloneWithSelections(
            SelectQueryNode.createFrom([from]),
            [SelectionNode.createSelectAll()]
          ),
          IdentifierNode.create(from.table.identifier.name)
        );
      });

      return super.transformFrom({
        ...node,
        froms: newFroms,
      });
    }

    protected transformUsing(node: UsingNode): UsingNode {
      const parentNode = this.getParentNode();

      if (!DeleteQueryNode.is(parentNode)) {
        return super.transformUsing(node);
      }

      const newTables = node.tables.map((table) => {
        if (!TableNode.is(table)) {
          // Only guard tables - non tables (subselects) will be handled further down in
          // the internal SelectQueryNode
          return table;
        }

        const guardResult = fullGuard.table(
          table.table,
          StatementType.Delete,
          TableUsageContext.TableInJoin
        );

        throwIfDenyWithReason(
          guardResult,
          `JOIN denied on table ${
            table.table.schema?.name ? `${table.table.schema.name}.` : ""
          }${table.table.identifier.name}`
        );

        if (guardResult === Allow) {
          return table;
        }

        // Must be an RLS case
        // Again, don't worry about the where clauses
        // those will be handled by the internal SelectQueryNode
        return AliasNode.create(
          SelectQueryNode.cloneWithSelections(
            SelectQueryNode.createFrom([table]),
            [SelectionNode.createSelectAll()]
          ),
          IdentifierNode.create(table.table.identifier.name)
        );
      });

      return super.transformUsing({
        ...node,
        tables: newTables,
      });
    }

    /**
     * Enforce column permissions in update set clause
     */
    // protected transform

    /**
     * Enforce column permissions in where clause
     * These are always wrapped in a reference node
     *
     * Reference nodes are also used in select statements, so we return early
     * if we're not in a recursion with a WhereNode parent
     */
    protected transformReference(node: ReferenceNode): ReferenceNode {
      const isAChildOfWhere = this.isAChildOf(WhereNode);
      const isAChildOfJoin = this.isAChildOf(JoinNode);

      if (!isAChildOfWhere && !isAChildOfJoin) {
        return super.transformReference(node);
      }

      // If it's a child of where, then it's a column reference
      // being used in a filter statement, so we call the guard with those parameters
      // However, the table may not be specified, and so we need to search up the stack
      // to something that has the table specified
      // The entity with the specified table should be the one that is the parent of the where node
      // but it could be an insert/update/delete or select statement

      // TODO - we're calling the table with the wrong column here because there could be a top level join
      // Need to refactor this to up front decide if the table specified is required

      let tableNode: TableNode;
      const tableNodeSpecifiedWithColumn = node.table;

      if (!tableNodeSpecifiedWithColumn) {
        // If it's a child of join, we need the table specified
        // It can't be inferred
        if (!isAChildOfWhere) {
          throw new Error(
            "kysely-access-control: could not find table node for column reference in join"
          );
        }

        const reversedStack = this.nodeStack.slice().reverse();
        const idxOfWhere = reversedStack.findIndex((node) =>
          WhereNode.is(node)
        );

        const idxOfParent = idxOfWhere + 1;
        const parentOfWhere = reversedStack[idxOfParent];

        invariant(
          parentOfWhere !== undefined,
          "kysely-access-control: could not find parent of where node"
        );

        const hasJoins = this._topLevelHasMoreThanOneTable(parentOfWhere);
        if (hasJoins) {
          throw new Error(
            "kysely-access-control: if joins are present, each column reference in where must specify the table"
          );
        }

        const foundTableNode =
          this._getTableNodeFromTopLevelQueryNode(parentOfWhere);

        invariant(
          foundTableNode !== undefined,
          "kysely-access-control: could not find table node for column reference in filter statement"
        );

        invariant(
          TableNode.is(foundTableNode),
          "kysely-access-control: node for column reference in filter statement must be a table node"
        );

        tableNode = foundTableNode;
      } else {
        tableNode = tableNodeSpecifiedWithColumn;
      }

      const columnNode = node.column;

      invariant(
        ColumnNode.is(columnNode),
        "kysely-access-control: select all in filter statement is not supported"
      );

      const guardResult = fullGuard.column(
        tableNode.table,
        columnNode.column,
        StatementType.Select,
        ColumnUsageContext.ColumnInWhereOrJoin
      );

      throwIfDenyWithReason(
        guardResult,
        `FILTER denied on column ${
          tableNode.table.schema?.name ? `${tableNode.table.schema.name}.` : ""
        }${tableNode.table.identifier.name}.${columnNode.column.name}`
      );

      // Must be allow now
      return super.transformReference(node);
    }

    /*
     * From here on down there are utility methods that are not directly called by the Kysely plugin machinery
     */

    /**
     * Get whether an SelectQueryNode, UpdateQueryNode, or DeleteQueryNode has more than one table in reference scope
     * for select and where clauses
     */
    protected _topLevelHasMoreThanOneTable(node: OperationNode): boolean {
      if (UpdateQueryNode.is(node)) {
        const fromJoin = node.from;
        if (fromJoin && fromJoin.froms.length > 0) {
          return true;
        }
        return false;
      }

      if (SelectQueryNode.is(node)) {
        const join = node.joins;
        return !!join && join.length > 0;
      }

      if (DeleteQueryNode.is(node)) {
        const using = node.using;
        if (using && using.tables && using.tables.length > 0) {
          return true;
        }
        return false;
      }

      throw new Error(
        "_topLevelHasMoreThanOneTable called with something that is not a select, update, or delete query"
      );
    }

    /**
     * Get the table node for a top level query type (select, update, delete, or insert)
     */
    protected _getTableNodeFromTopLevelQueryNode(
      node: OperationNode
    ): TableNode {
      if (UpdateQueryNode.is(node)) {
        invariant(
          node.table !== undefined && TableNode.is(node.table),
          "kysely-access-control: update query must have a table"
        );

        return node.table;
      }

      if (SelectQueryNode.is(node)) {
        invariant(
          node.from !== undefined && node.from.froms.length === 1,
          "kysely-access-control: select query must have exactly one from"
        );

        invariant(
          TableNode.is(node.from.froms[0]),
          "kysely-access-control: select query must have a table"
        );

        return node.from.froms[0];
      }

      if (DeleteQueryNode.is(node)) {
        invariant(
          node.from !== undefined && node.from.froms.length === 1,
          "kysely-access-control: delete query must have exactly one from"
        );

        invariant(
          TableNode.is(node.from.froms[0]),
          "kysely-access-control: delete query must have a table"
        );

        return node.from.froms[0];
      }

      if (InsertQueryNode.is(node)) {
        invariant(
          TableNode.is(node.into),
          "kysely-access-control: insert query must have a table"
        );

        return node.into;
      }

      throw new Error(
        "_getTopLevelTableNode called with something that is not a select, update, delete, or insert query"
      );
    }

    /**
     * Common utility used in transformSelectQuery, transformReturning, etc.
     * that enforces column select permissions
     */
    protected _transformSelections(
      selections: SelectionNode[],
      tableNode: TableNode,
      scopedHasMoreThanOneTable: boolean,
      statementType: StatementType
    ): SelectionNode[] {
      const transformedSelections: SelectionNode[] = [];

      // We only allow a select all IF it's inside of a join
      // otherwise, we require that the user specifies the columns
      const selectAllIsAllowed =
        this.isAChildOf(JoinNode) ||
        this.isAChildOf(FromNode) ||
        this.isAChildOf(UsingNode);

      if (selectAllIsAllowed) {
        return selections.slice();
      }

      for (const selectionNode of selections) {
        const { selection } = selectionNode;

        // TODO - allow selectAll if it's not top level
        invariant(
          ReferenceNode.is(selection),
          "kysely-access-control: selection must be a reference node"
        );

        const { table: columnIncludedTableNode, column: columnNode } =
          selection;

        invariant(
          columnNode.kind !== "SelectAllNode",
          "kysely-access-control: .selectAll() is not supported"
        );

        let tableNodeToUseForColumn: TableNode = tableNode;

        if (scopedHasMoreThanOneTable) {
          invariant(
            columnIncludedTableNode !== undefined,
            `kysely-access-control: table must be specified for each column when joining - could not infer table for ${columnNode.column.name}`
          );

          tableNodeToUseForColumn = columnIncludedTableNode;
        }

        const guardResult = fullGuard.column(
          tableNodeToUseForColumn.table,
          columnNode.column,
          statementType,
          ColumnUsageContext.ColumnInSelectOrReturning
        );

        throwIfDenyWithReason(
          guardResult,
          `SELECT denied on column ${
            tableNodeToUseForColumn.table.schema?.name
              ? `${tableNodeToUseForColumn.table.schema.name}.`
              : ""
          }${tableNodeToUseForColumn.table.identifier.name}.${
            columnNode.column.name
          }`
        );

        if (guardResult === Omit) {
          continue;
        }

        transformedSelections.push(selectionNode);
      }

      return transformedSelections;
    }

    protected _transformWhere(
      guardResult: TableGuardResult<KyselyDatabase>,
      nodeWhere?: WhereNode
    ): WhereNode | undefined {
      if (guardResult === Allow) {
        return nodeWhere;
      }

      const guardWhereUnguarded =
        guardResult[0] === Allow ? guardResult[1] : undefined;

      invariant(
        guardWhereUnguarded !== undefined &&
          typeof guardWhereUnguarded === "object" &&
          "toOperationNode" in guardWhereUnguarded,
        "kysely-access-control: returned where must be an expression wrapper"
      );

      const guardWhere = WhereNode.create(
        guardWhereUnguarded.toOperationNode()
      );

      const newWhere =
        guardWhere && nodeWhere
          ? WhereNode.create(AndNode.create(guardWhere.where, nodeWhere.where))
          : guardWhere || nodeWhere;

      return super.transformWhere(newWhere);
    }
  }

  const plugin: KyselyPlugin = {
    transformQuery: (args: PluginTransformQueryArgs): RootOperationNode => {
      const transformer = new Transformer();
      return transformer.transformNode(args.node);
    },

    transformResult: (
      args: PluginTransformResultArgs
    ): Promise<QueryResult<UnknownRow>> => {
      return Promise.resolve(args.result);
    },
  };

  return plugin;
};
