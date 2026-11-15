namespace Ferry.Api.Services;

public class BookingService
{
    public Booking Place(OrderRequest request) => new Booking(request);
}

public class SeatMap
{
    public SeatList Upper() => SeatList.Empty;
    public SeatList Lower() => SeatList.Empty;
    public SeatList Car() => SeatList.Empty;
}

public class Timetable
{
    public Sailing Find(int id) => Sailing.None;
    public StopList Stops(int id) => StopList.Empty;
    public ImportResult Import(UploadRequest request) => ImportResult.Done;
    public Board Today() => Board.Empty;
}

public class ManifestStore
{
    public SaveResult Save(FileRequest request) => SaveResult.Done;
    public SaveResult Stamp(StampRequest request) => SaveResult.Done;
}

public class FareDesk
{
    public Fare Quote() => Fare.None;
    public Fare Loop() => Fare.None;
    public Fare Either() => Fare.None;
    public Fare Built() => Fare.None;
    public Fare Elsewhere() => Fare.None;
    public Fare Named() => Fare.None;
}

public class GateDesk
{
    public Task<ActionResult<CheckInResult>> Admit(CheckInRequest request) => Task.FromResult(new ActionResult<CheckInResult>(CheckInResult.Done));
}
