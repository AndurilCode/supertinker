ONLY ONE RULE:
supertinker.ts must remain a single file, with zero dependencies. 
It's supposed to be a core that can be extended indefinitely, through hooks, providers, workflows, storage adapters.
While iterating on this codebase to add new features, the @supertinker.ts must remain unchanged, as soon as it's not strictly necessary (meaning that the supertinker.ts capability to be fully extensible is not yet fulfilled).
While ideating the solution, firstly rely on the extensions/plugins mechanisms available.