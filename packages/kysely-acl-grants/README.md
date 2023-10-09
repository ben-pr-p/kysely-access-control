# kysely-acl-grants

`kysely-acl-grants` implements a similar set of permissions to those implemented by Postgres internally.
It is implemented on top of `kysely-acl`. **Please read the Limitations section of that README before using this library**.

This library implements are permission system that is composed of simple grants, and is intended to be very similar to those implemented
inside of Postgres itself. It is specifically like Postgres in that:
- **It's additive**: if you have 2 grants on a table that each specify a set of allowed columns, you can access the union of those 2 sets.
- **It's allow only**: there are no deny rules, only allow rules.
- **It's context independent**: if a user doesn't have select on a table, they can't access data in that table even just to join to it or filter by it with a sub-select even if they aren't returning data from that table
- **You need at least select on a column to filter by it**: this follows from the above, but you need at least select on a column to filter by it.

If these rules don't work for you, you can implement your own solution on top of the lower level `kysely-acl`.

# Usage

We export a simple `Grant` type, like:
```typescript
type Grant = {
	on: Table;
	for: 'select' | 'insert' | 'update' | 'delete' | 'all'
	columns: string[]
	where?: (
    eb: ExpressionBuilder<KyselyDatabase, TableName>
  ) => ExpressionWrapper<KyselyDatabase, TableName, SqlBool>;
  whereType?: "permissive" | "restrictive";
}
```

`Grant.where` and `Grant.whereType` function similar to Postgres [row level security](https://www.postgresql.org/docs/current/sql-createpolicy.html).

<!-- TODO: that you can generate grants dynamically in response to user context -->
<!-- or have them be static -->
<!-- If they are static, they can modify generated types -->
<!-- You can pass a statically defined set of grants to `withPlugin`:
```typescript
// const grantsForUsers
// const grantsForAdmins

const 
``` -->


## Only Table/Column Grants

Currently only table x column permissions are implemented, i.e. all grants look like:
```sql
grant select (id, first_name, last_name) on person to a;
```

There is no intent to implement schema level ownership or other higher level permissions.
If you want a user to be able to access everything, just skip the `.withPlugin()` call.
