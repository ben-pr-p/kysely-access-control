# kysely-grants

`kysely-grants` implements a similar set of permissions to those implemented by Postgres internally.
It is implemented on top of [`kysely-access-control`](https://github.com/ben-pr-p/kysely-utils/tree/main/packages/kysely-access-control). **Please read the Limitations section of that README before using this library**.

This library implements are permission system that is composed of simple grants, and is intended to be very similar to those implemented
inside of Postgres itself. It is specifically like Postgres in that:
- **It's additive**: if you have 2 grants on a table that each specify a set of allowed columns, you can access the union of those 2 sets.
- **It's allow only**: there are no deny rules, only allow rules.
- **It's context independent**: if a user doesn't have select on a table, they can't access data in that table even just to join to it or filter by it with a sub-select even if they aren't returning data from that table
- **You need at least select on a column to filter by it**: this follows from the above, but you need at least select on a column to filter by it.

If these rules don't work for you, you can implement your own solution on top of the lower level `kysely-access-control`.

## Usage

Construct a `Grant` with the following type, like:
```typescript
type Grant = {
	on: Table;
	for: 'select' | 'insert' | 'update' | 'delete' | 'all'
	columns?: string[] // all columns are allowed if blank
	where?: (
    eb: ExpressionBuilder<KyselyDatabase, TableName>
  ) => ExpressionWrapper<KyselyDatabase, TableName, SqlBool>;
  whereType?: "permissive" | "restrictive";
}
```

`Grant.where` and `Grant.whereType` function similar to Postgres [row level security](https://www.postgresql.org/docs/current/sql-createpolicy.html).

You can check a list of grants into your codebase, like:
```typescript
// in some file db.ts
import { createKyselyGrantGuard } from 'kysely-grants'
import { createAccessControlPlugin } from 'kysely-access-control'

const getSharedGrants = (currentUserId) => [
	{
		on: 'posts',
		for: 'select'
	},
	{
		on: 'comments',
		for: 'select'
	},
	{
		on: 'posts',
		for: 'all',
		where: (eb) => eb.eq('author_id', currentUserId)
	},
	{
		on: 'comments',
		for: 'all',
		where: (eb) => eb.eq('author_id', currentUserId)
	}
]

const adminGrants = [
	{
		on: 'accounts',
		for: 'all',
	}
]

const query = (userId, isAdmin) => {
	return db.withPlugin(createAccessControlPlugin(
		createKyselyGrantGuard(
			getSharedGrants(userId).concat(isAdmin ? adminGrants : [])
		)
	)
}

// in some api.ts
import { query } from './db.ts'

// in some request handler
// this query will have permissions enforced
await query(req.user.id, req.user.isAdmin).select('posts.*').from('posts').execute()
```

Or you can generate them from a database, storing them in some `grants` table, or 
anything else you can think of.

In my projects, I'm constructing the plugin in response to each request.  In one, I'm doing it in a [tRPC middleware](https://trpc.io/docs/server/middlewares) and adding it to the RPC's context. 


### Only Table/Column Grants

Currently only table x column permissions are implemented, i.e. all grants look like:
```sql
grant select (id, first_name, last_name) on person to a;
```

There is no intent to implement schema level ownership or other higher level permissions.
If you want a user to be able to access everything, just skip the `.withPlugin()` call.
