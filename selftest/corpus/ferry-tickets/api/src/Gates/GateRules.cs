namespace Ferry.Api.Gates;

public class GateRules
{
    public IReadOnlyList<Ticket> Boardable(IEnumerable<Ticket> tickets, bool late)
    {
        return tickets.Where(t => late || t.Priority).ToList();
    }

    public string Holder(Ticket ticket, string fallback)
    {
        var name = ticket.Name ?? fallback;
        var seat = ticket.Seat ?? throw new ArgumentException("seat");
        var gate = ticket.Gate ?? throw ticket.Missing;
        ticket.Note ??= "none";
        int? count = null;
        var size = (int?)ticket.Size;
        var deck = ticket?.Deck;
        return count > 0 ? name : seat + gate;
    }

    public int Rank(int x) => x > 3 ? 1 : x > 2 ? 2 : 3;

    public bool Checks(IEnumerable<Ticket> tickets) =>
        tickets.Any(t => t.Late) && tickets.All((t) => t.Paid) && tickets.FirstOrDefault(IsVip) != null;

    private bool IsVip(Ticket ticket) => ticket.Vip;
}
