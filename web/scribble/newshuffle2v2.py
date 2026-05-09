from random import shuffle
import random


class person:
    def __init__(self, name):
        self.name = name
        self.time_since_last_played = 0
        self.amount_times_played = 0
        self.amount_times_played_in_a_row = 0
        self.who_not_played_before = []
    
    def increment_time_since_last_played(self):
        self.time_since_last_played += 1

    def reset_time_since_last_played(self):
        self.time_since_last_played = 0

    def increment_amount_times_played(self):
        self.amount_times_played += 1

    def increment_amount_times_played_in_a_row(self):
        self.amount_times_played_in_a_row += 1

    def reset_amount_times_played_in_a_row(self):
        self.amount_times_played_in_a_row = 0
    
    def add_who_not_played_before(self, name):
        self.who_not_played_before.append(name)
    
    def played_match(self, with_player):
        self.reset_time_since_last_played()
        self.increment_amount_times_played()
        self.increment_amount_times_played_in_a_row()
        if with_player in self.who_not_played_before:
            self.who_not_played_before.remove(with_player)



def get_lowest_played_player(people):
    least_played_amount = min(person.amount_times_played for person in people)
    list_of_least_played = [person for person in people if person.amount_times_played == least_played_amount]
    #shuffle(list_of_least_played)
    return list_of_least_played[0]


def get_lowest_played_players(people):
    least_played_amount = min(person.amount_times_played for person in people)
    list_of_least_played = [person for person in people if person.amount_times_played == least_played_amount]
    #shuffle(list_of_least_played)
    return list_of_least_played


def get_lowest_played_in_a_row_players(people):
    least_played_in_a_row_amount = min(person.amount_times_played_in_a_row for person in people)
    list_of_least_played_in_a_row = [person for person in people if person.amount_times_played_in_a_row == least_played_in_a_row_amount]
    #shuffle(list_of_least_played_in_a_row)
    return list_of_least_played_in_a_row


def get_highest_time_since_last_played_players(people):
    highest_time_since_last_played_amount = max(person.time_since_last_played for person in people)
    list_of_highest_time_since_last_played = [person for person in people if person.time_since_last_played == highest_time_since_last_played_amount]
    #shuffle(list_of_highest_time_since_last_played)
    return list_of_highest_time_since_last_played

def get_next_player(people):
    if not people:
        return None
    candidates = get_lowest_played_players(people)
    if len(candidates) == 1:
        return candidates[0]

    candidates = get_highest_time_since_last_played_players(candidates)
    if len(candidates) == 1:
        return candidates[0]

    candidates = get_lowest_played_in_a_row_players(candidates)
    return candidates[0] if candidates else None


def add_paused_player(people, paused_player):
    if paused_player in people:
        people.remove(paused_player)

def remove_paused_player(people, paused_player):
    if paused_player not in people:
        people.append(paused_player)


def generate_schedule(people):
    matches = []
    rounds_data = []
    paused_players = []

    while True:
        first_player = get_next_player(people)
        if not first_player:
            break
        list_of_people_first_has_not_played_with = [person for person in people if first_player.name in person.who_not_played_before and person not in paused_players]
        second_player = get_next_player(list_of_people_first_has_not_played_with)
        if not second_player:
            break

        third_player = get_next_player([person for person in people if person.name != first_player.name and person.name != second_player.name and person not in paused_players])
        if not third_player:
            break
        
        list_of_people_third_has_not_played_with = [person for person in people if third_player.name in person.who_not_played_before and person.name != first_player.name and person.name != second_player.name and person not in paused_players]
        fourth_player = get_next_player(list_of_people_third_has_not_played_with)
        if not fourth_player:
            break

        print(f"{first_player.name} & {second_player.name} vs {third_player.name} & {fourth_player.name}")
        matches.append(f"{first_player.name} & {second_player.name} vs {third_player.name} & {fourth_player.name}")

        first_player.played_match(second_player.name)
        second_player.played_match(first_player.name)
        third_player.played_match(fourth_player.name)
        fourth_player.played_match(third_player.name)

        players = [first_player.name, second_player.name, third_player.name, fourth_player.name]

        ppl_not_in_match = [person for person in people if person.name not in players]
        for p in ppl_not_in_match:
            p.increment_time_since_last_played()
            p.reset_amount_times_played_in_a_row()
        
        # Save snapshot of this round for statistics
        round_stats = {
            "match": matches[-1],
            "player_stats": {p.name: {"played": p.amount_times_played, "wait_time": p.time_since_last_played, "streak": p.amount_times_played_in_a_row} for p in people}
        }
        rounds_data.append(round_stats)

        if random.random() < 0.1:  # Simulate a pause with 10% chance
            
            randomly_selected_player = random.choice(people)
            add_paused_player(people, randomly_selected_player)
            paused_players.append(randomly_selected_player)
            print(f'Pausing player: {randomly_selected_player.name}')
        elif paused_players and random.random() < 0.1:  # Simulate resuming with 10% chance
            randomly_selected_paused_player = random.choice(paused_players)
            remove_paused_player(people, randomly_selected_paused_player)
            paused_players.remove(randomly_selected_paused_player)
            print(f'Resuming player: {randomly_selected_paused_player.name}')

    return matches, rounds_data

def reset_people(people):
    for p in people:
        p.who_not_played_before = []
    for i, p in enumerate(people):
        for pp in people[i + 1:]:
            p.add_who_not_played_before(pp.name)
            pp.add_who_not_played_before(p.name)

def init_people(names):
    people = [person(p) for p in names]
    for i, p in enumerate(people):
        for pp in people[i + 1:]:
            p.add_who_not_played_before(pp.name)
            pp.add_who_not_played_before(p.name)
    return people

if __name__ == "__main__":
    names = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P"]
    people = init_people(names)
    generate_schedule(people)

