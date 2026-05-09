import statistics
from newshuffle2v2 import init_people, generate_schedule

def run_stats():
    names = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K"]
    people = init_people(names)
    
    print(f"--- Starting Tournament with {len(names)} players ---")
    matches, rounds_data = generate_schedule(people)
    
    print("\n--- ROUND BY ROUND OVERVIEW ---")
    for i, r in enumerate(rounds_data):
        print(f"\nRound {i + 1}: {r['match']}")
        print("Player Status (Plays / Wait Time / Streak):")
        
        # Sort by wait time descending
        sorted_stats = sorted(r['player_stats'].items(), key=lambda item: item[1]['wait_time'], reverse=True)
        
        stat_strs = []
        for name, stats in sorted_stats:
            stat_strs.append(f"{name}: {stats['played']}p/{stats['wait_time']}w/{stats['streak']}s")
            
        print(" | ".join(stat_strs))

    print("\n\n--- FINAL STATISTICS ---")
    print(f"Total Matches Played: {len(matches)}")
    
    plays = [p.amount_times_played for p in people]
    waits = [p.time_since_last_played for p in people]
    
    print("\nGames Played per Player:")
    for p in people:
        print(f"  {p.name}: {p.amount_times_played} matches")
        
    print("\nOverall Stats:")
    print(f"  Max Matches: {max(plays)}")
    print(f"  Min Matches: {min(plays)}")
    if len(plays) >= 2:
        print(f"  Standard Deviation of Matches: {statistics.stdev(plays):.2f}")
    
    print(f"  Max Final Wait Time: {max(waits)}")

if __name__ == "__main__":
    run_stats()
