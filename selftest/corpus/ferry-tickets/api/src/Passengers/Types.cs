namespace Ferry.Api.Passengers;

public interface IVoyageStore
{
    Voyage Load(int id);
    Task<Voyage> LoadAsync(int id);
    decimal Total(int id);
    ReceiptLine Line(int id);
}

public class VoyageStore : IVoyageStore
{
    public Voyage Load(int id)
    {
        return new Voyage();
    }

    public Task<Voyage> LoadAsync(int id)
    {
        return Task.FromResult(new Voyage());
    }

    public decimal Total(int id)
    {
        return 0m;
    }

    public ReceiptLine Line(int id)
    {
        return new ReceiptLine();
    }
}

public class Voyage
{
    public void Close()
    {
    }

    public Summary ToSummary() => new Summary();
}

public class Cabin
{
    public void Lock()
    {
    }

    public string Describe() => "cabin";
}

public class Passenger
{
    public string Name { get; set; }
    public int VoyageId { get; set; }
}

public class Profile
{
    public Badge ToBadge() => new Badge();
}

public static class PassengerExtensions
{
    public static Profile ToProfile(this Passenger passenger) => new Profile();

    public static Holder ToHolder(this Passenger passenger) => new Holder();
}

public interface IFareTable
{
    Fare PriceFor(int id);
}

public class FareTable : IFareTable
{
    public Fare PriceFor(int id) => Fare.None;
}

public interface IDock
{
    void Moor();
}

public interface IPier
{
    void Moor();
}

public interface IPort : IDock, IPier
{
}
