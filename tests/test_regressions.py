import unittest

from game.accounts import AccountManager
from game.cards import Card
from game.engine import Room
from game.storage import InMemoryStorage


class AccountRegressionTests(unittest.TestCase):
    def setUp(self):
        self.accounts = AccountManager()
        self.accounts.storage = InMemoryStorage()
        self.alice = self.accounts.register("Alice", "+26134000001", "password")
        self.bob = self.accounts.register("Bob", "+26134000002", "password")

    def test_friend_request_is_received_by_target_and_can_be_accepted(self):
        target, created = self.accounts.add_friend_request(
            self.alice["id"], self.bob["id"]
        )
        self.assertTrue(created)
        self.assertEqual(target["id"], self.bob["id"])
        self.assertEqual(self.accounts.friends_for(self.alice["id"]), ([], []))
        _, pending = self.accounts.friends_for(self.bob["id"])
        self.assertEqual([p["id"] for p in pending], [self.alice["id"]])

        self.accounts.accept_friend_request(self.bob["id"], self.alice["id"])
        alice_friends, alice_pending = self.accounts.friends_for(self.alice["id"])
        bob_friends, bob_pending = self.accounts.friends_for(self.bob["id"])
        self.assertEqual([p["id"] for p in alice_friends], [self.bob["id"]])
        self.assertEqual([p["id"] for p in bob_friends], [self.alice["id"]])
        self.assertEqual(alice_pending, [])
        self.assertEqual(bob_pending, [])


class RoomRegressionTests(unittest.TestCase):
    def test_finished_room_can_be_polled_after_winner_leaves(self):
        room = Room("ABCDE")
        winner = room.add_player("Alice", account_id="alice")
        remaining = room.add_player("Bob", account_id="bob")
        room.phase = "finished"
        room.winner_id = winner.id
        room.host_id = winner.id
        room.win_reason = "Test"

        room.leave(winner.id)
        state = room.state_for(remaining.id)
        self.assertIsNone(state["winner_name"])
        self.assertEqual(state["nb_players"], 1)

    def test_disconnected_bot_can_trigger_three_joker_win(self):
        room = Room("ABCDE")
        bot = room.add_player("Bot", account_id="bot")
        room.add_player("Alice", account_id="alice")
        room.phase = "playing"
        room.turn_index = 0
        room.turn_stage = "draw"
        room.joker_info = {"rank": "A", "color": "Noir", "suits": ["Pique", "Trefle"]}
        bot.hand = [Card("A", "Pique", 0), Card("A", "Pique", 1)]
        # La pioche se consomme par la fin de la liste.
        room.deck = [Card("2", "Coeur", 0), Card("A", "Trefle", 0)]
        bot.connected = False

        room._bot_play_current_turn()
        self.assertEqual(room.phase, "finished")
        self.assertEqual(room.winner_id, bot.id)

    def test_invalid_declaration_payload_returns_value_error(self):
        room = Room("ABCDE")
        player = room.add_player("Alice", account_id="alice")
        room.add_player("Bob", account_id="bob")
        room.phase = "playing"
        room.turn_index = 0
        room.turn_stage = "discard"

        with self.assertRaises(ValueError):
            room.declare(player.id, None, "card-id")

    def test_empty_deck_does_not_reuse_an_old_round_winner(self):
        room = Room("ABCDE")
        room.add_player("Alice", account_id="alice")
        room.add_player("Bob", account_id="bob")
        room.last_winner_id = "alice"

        room._end_by_empty_deck()
        self.assertIsNone(room.last_winner_id)


if __name__ == "__main__":
    unittest.main()
