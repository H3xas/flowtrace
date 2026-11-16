namespace Ferry.Api.Passengers;

public class PassengerService
{
    private readonly IVoyageStore _voyages;
    private readonly IServiceProvider _provider;

    public PassengerService(IVoyageStore voyages, IServiceProvider provider)
    {
        _voyages = voyages;
        _provider = provider;
    }

    public Voyage Lookup(int id) => _voyages.Load(id);

    public Voyage LookupBlock(int id)
    {
        return _voyages.Load(id);
    }

    public string Label(Passenger passenger) => Format(Shorten(passenger.Name));

    public Fare Price(int id) => _provider.GetRequiredService<IFareTable>().PriceFor(id);

    public Badge Badge(Passenger passenger) => passenger.ToProfile().ToBadge();

    public TicketDto Ticket(Passenger passenger) => new TicketDto
    {
        Holder = passenger.ToHolder(),
        Voyage = _voyages.Load(passenger.VoyageId),
    };

    public Receipt Receipt(Passenger passenger)
    {
        var receipt = new Receipt { Total = _voyages.Total(passenger.VoyageId) };
        var lines = new List<ReceiptLine> { _voyages.Line(passenger.VoyageId) };
        return receipt;
    }

    public async Task<Summary> Summarize(int id) => (await _voyages.LoadAsync(id)).ToSummary();

    public void Board(int id, IPort port)
    {
        Voyage voyage = _voyages.Load(id);
        voyage.Close();
        var cabin = new Cabin();
        cabin.Lock();
        var thing = Outside.Make();
        thing.Describe();
        port.Moor();
    }

    private string Shorten(string name) => name;

    private string Format(string name) => name;
}
