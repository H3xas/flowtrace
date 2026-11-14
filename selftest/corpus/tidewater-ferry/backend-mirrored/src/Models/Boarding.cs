namespace Tidewater.Ferry.Models
{
    public class PassengerRequest
    {
        public string PassengerId { get; set; }
        public string RouteId { get; set; }
        public bool LoadPermits { get; set; }
        public int TicketCount { get; set; }
    }

    public class PassengerIdentity
    {
        public string PassengerId { get; set; }
    }
}
