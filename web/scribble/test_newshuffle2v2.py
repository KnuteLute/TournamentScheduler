import unittest
from newshuffle2v2 import person, get_next_player, init_people, generate_schedule

class TestShuffle(unittest.TestCase):
    def test_person_initialization(self):
        p = person("A")
        self.assertEqual(p.name, "A")
        self.assertEqual(p.time_since_last_played, 0)
        self.assertEqual(p.amount_times_played, 0)
        self.assertEqual(p.amount_times_played_in_a_row, 0)
        self.assertEqual(p.who_not_played_before, [])

    def test_played_match(self):
        p = person("A")
        p.add_who_not_played_before("B")
        p.played_match("B")
        self.assertEqual(p.amount_times_played, 1)
        self.assertEqual(p.amount_times_played_in_a_row, 1)
        self.assertEqual(p.time_since_last_played, 1)
        self.assertNotIn("B", p.who_not_played_before)

    def test_get_next_player(self):
        people = init_people(["A", "B", "C"])
        
        # P1 plays a match, so their play count increases
        people[0].played_match("B") 
        
        # Next player should be B or C, since A has played
        next_p = get_next_player(people)
        self.assertIn(next_p.name, ["B", "C"])

    def test_generate_schedule(self):
        # Using a multiple of 4 to ensure matches form properly
        people = init_people(["A", "B", "C", "D"])
        matches, _ = generate_schedule(people)
        
        # There's 1 possible pairwise combination for completely unique partners with 4 people:
        # Actually (A, B) vs (C, D) then another combination etc.
        self.assertTrue(len(matches) > 0)
        
        # Each person should have played at least once
        for p in people:
            self.assertTrue(p.amount_times_played > 0)

if __name__ == "__main__":
    unittest.main()
