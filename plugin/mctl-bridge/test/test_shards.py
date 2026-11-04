"""Pure-python proof that the mutation shards partition the list exactly.

Run from plugin/mctl-bridge:  python3 -m unittest discover -s test -p 'test_*.py'
"""
import importlib.util, os, subprocess, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("mutate", os.path.join(HERE, "mutate.py"))
mutate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mutate)  # defines M and helpers; runs nothing

REAL = [e[0] for e in mutate.M]

class ShardPartition(unittest.TestCase):
    def check(self, items, n):
        shards = [mutate.shard_of(items, i, n) for i in range(1, n + 1)]
        flat = [x for s in shards for x in s]
        self.assertEqual(len(flat), len(set(flat)), "a name appears in two shards")
        self.assertEqual(sorted(flat), sorted(items), "union is not the whole list")
        return shards

    def test_real_list_all_n(self):
        self.assertGreater(len(REAL), 50)
        for n in (1, 2, 3, 4, 5, 7):
            shards = self.check(REAL, n)
            self.assertTrue(all(shards), f"empty shard for N={n}")

    def test_synthetic_lists(self):
        for size in (1, 2, 3, 4, 5, 9, 10, 11):
            for n in (1, 2, 3, 4, 5):
                self.check([f"m{k}" for k in range(size)], n)

    def test_round_robin_rule(self):
        self.assertEqual(mutate.shard_of(list(range(10)), 2, 4), [1, 5, 9])

    def test_real_names_unique(self):
        self.assertEqual(len(REAL), len(set(REAL)))

    def test_spec_validation(self):
        for bad in ("0/4", "5/4", "1/0", "x", "1", "1/2/3", "-1/4"):
            with self.assertRaises(SystemExit, msg=bad):
                mutate.parse_shard(bad)

class EmptyShardIsAnError(unittest.TestCase):
    def run_cli(self, *a):
        return subprocess.run([sys.executable, os.path.join(HERE, "mutate.py"), *a],
                              cwd=os.path.dirname(HERE), capture_output=True, text=True)

    def test_empty_shard_fails(self):
        r = self.run_cli("--shard", "1000/1000")  # more shards than mutations
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("empty shard", r.stderr)

    def test_list_matches_partition(self):
        for i in range(1, 5):
            r = self.run_cli("--list-shard", f"{i}/4")
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(r.stdout.split("\n")[:-1], mutate.shard_of(REAL, i, 4))

if __name__ == "__main__":
    unittest.main()
